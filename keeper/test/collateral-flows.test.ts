/** Collateral mode in wiring, `status`, `replay` and `verify`. */
import type { Address, Hex } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { CHAINS } from '../src/chains.js';
import type { KeeperConfig } from '../src/config.js';
import { parseWad } from '../src/decision.js';
import { deriveRescuerAddress } from '../src/derive.js';
import type { RunRecord } from '../src/evidence.js';
import type { EvmReceipt, EvmTransaction } from '../src/evm.js';
import type { NearTxStatus, NearViews } from '../src/near.js';
import { replayRun } from '../src/replay.js';
import { tick } from '../src/rescue.js';
import { rescueContext, wirePosition } from '../src/setup.js';
import { describePosition } from '../src/status.js';
import { ABOVE_TRIGGER_SELECTOR, type HelperConfig, unwindCalldata } from '../src/unwind.js';
import { type Lookups, signingHash, verifyRun } from '../src/verify.js';
import {
  type Harness,
  borrower,
  collateralHarness,
  collateralOf,
  collateralTarget,
  fakeEvm,
  fakeNear,
  helper,
  openPosition,
  positionTarget,
  sickSample,
  unwoundLog,
  weth,
} from './support/fakes.js';
import { repayCalldata } from './support/simulated-mpc.js';

const stranger: Address = '0x4444444444444444444444444444444444444444';

// Recorded from v1.signer-prod.testnet 3.18.0, as in setup.test.ts.
const root =
  'secp256k1:4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8fGBiJB8TBtFMP5WWXz6B89Ac1fbpzPwAvoyQebemHFwx3';
const levee1 =
  'secp256k1:5ikbbmFA1mE31RonV1gFapgNsu9zh5gwomzTQc4LjxXQQENXwu45cqBMgkaNGikEtYWVKrjH6mNzQbwSQu2B74mY';
const derived = deriveRescuerAddress(root, 'levee.testnet', 1);

describe('wiring a position in collateral mode', () => {
  const config: KeeperConfig = {
    network: 'testnet',
    contract: 'levee.testnet',
    mpc: 'v1.signer-prod.testnet',
    nearRpcUrl: 'https://near.invalid',
    positions: [collateralTarget],
    evidenceDir: '/tmp/unused',
    rpcUrls: () => ['https://a.invalid', 'https://b.invalid'],
    feeCeilings: () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 10n }),
  };
  const sepolia = CHAINS[84532] as NonNullable<(typeof CHAINS)[84532]>;
  const onContract = openPosition({ chain_id: 84532, collateral: { asset: weth, pool_fee: 500 } });
  const views = (over: Partial<NearViews> = {}): NearViews => ({
    getPosition: async () => onContract,
    rootPublicKey: async () => root,
    derivedPublicKey: async () => levee1,
    getChain: async () => ({ chain_id: 84532, pool: sepolia.pool, usdc: sepolia.usdc, unwind: helper }),
    ...over,
  });
  const agreed: HelperConfig = {
    rescuer: derived,
    maxSlippageBps: 100n,
    triggerHf: parseWad('1.25'),
    targetHf: parseWad('1.6'),
    collateral: weth,
    poolFee: 500n,
  };
  const wire = (
    nearViews = views(),
    helperConfig: HelperConfig | Error | ((url: string) => HelperConfig | Error) = agreed,
  ) =>
    wirePosition(config, nearViews, collateralTarget, (url) => {
      const client = fakeEvm(url);
      client.helperConfig = typeof helperConfig === 'function' ? helperConfig(url) : helperConfig;
      return client;
    });

  it('reads the asset and fee from the contract and the helper from get_chain', async () => {
    const wiring = await wire();

    expect(wiring.collateral).toEqual({
      asset: weth,
      helper,
      poolFee: 500n,
      quoter: sepolia.quoterV2,
      helperConfig: agreed,
    });
    expect(wiring.rescuer).toBe(derived);
  });

  it('uses the QuoterV2 verified for each chain with a helper', () => {
    expect(CHAINS[8453]?.quoterV2).toBe('0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a');
    expect(CHAINS[42161]?.quoterV2).toBe('0x61fFE014bA17989E743c5F6cB21bF9697530B21e');
    expect(CHAINS[84532]?.quoterV2).toBe('0xC5290058841028F1614F3A6F0F5816cAd0df5E27');
  });

  it('refuses a chain with no known QuoterV2', async () => {
    const arbitrumSepolia = views({
      getPosition: async () =>
        openPosition({ chain_id: 421614, collateral: { asset: weth, pool_fee: 500 } }),
    });
    await expect(wire(arbitrumSepolia)).rejects.toThrow(/no Uniswap v3 QuoterV2/);
  });

  it('hands the collateral terms to the rescue context', async () => {
    const wiring = await wire();
    const ctx = rescueContext({
      config,
      wiring,
      views: views(),
      near: fakeNear({ address: derived, sign: () => { throw new Error('unused'); } }),
      log: () => {},
    });

    expect(ctx.collateral).toEqual({ asset: weth, helper, poolFee: 500n, quoter: sepolia.quoterV2 });
  });

  it('refuses a position registered without a collateral config', async () => {
    const reserveOnly = views({ getPosition: async () => openPosition({ chain_id: 84532, collateral: null }) });
    await expect(wire(reserveOnly)).rejects.toThrow(/no collateral config/);
  });

  it('refuses a contract with no helper for the chain', async () => {
    await expect(wire(views({ getChain: async () => null }))).rejects.toThrow(/no LeveeUnwind helper/);
    const v01 = views({ getChain: async () => ({ chain_id: 84532, pool: sepolia.pool, usdc: sepolia.usdc }) });
    await expect(wire(v01)).rejects.toThrow(/no LeveeUnwind helper/);
  });

  it.each<[string, Partial<HelperConfig>, RegExp]>([
    ['trigger', { triggerHf: parseWad('1.3') }, /trigger/],
    ['target', { targetHf: parseWad('1.5') }, /target/],
    ['slippage limit', { maxSlippageBps: 300n }, /max_slippage_bps/],
    ['rescuer', { rescuer: stranger }, /authorized rescuer/],
    ['collateral', { collateral: stranger }, /collateral .* registered on NEAR/],
    ['pool fee', { poolFee: 3_000n }, /pool fee 3000 at the helper, 500 registered on NEAR/],
  ])('refuses to start when the helper has another %s', async (_name, change, message) => {
    await expect(wire(views(), { ...agreed, ...change })).rejects.toThrow(message);
  });

  it('refuses to start when no endpoint can read the helper', async () => {
    await expect(wire(views(), new Error('no such contract'))).rejects.toThrow(/could not read the helper config/);
  });

  it('refuses to start when endpoints disagree on the helper', async () => {
    const split = (url: string) => (url.includes('b.') ? { ...agreed, triggerHf: 1n } : agreed);
    await expect(wire(views(), split)).rejects.toThrow(/disagree/);
  });

  it('starts on the endpoints that answer, if they agree', async () => {
    const one = (url: string) => (url.includes('b.') ? new Error('down') : agreed);
    expect((await wire(views(), one)).collateral?.helper).toBe(helper);
  });

  it('does not ask for a helper in reserve mode', async () => {
    let asked = false;
    const wiring = await wirePosition(
      config,
      views({
        getChain: async () => {
          asked = true;
          return null;
        },
      }),
      positionTarget,
      (url) => fakeEvm(url),
    );
    expect(wiring.collateral).toBeUndefined();
    expect(asked).toBe(false);
  });

  it('shows the collateral and what it would repay in status', async () => {
    const wiring = await wire();
    for (const client of wiring.clients as ReturnType<typeof fakeEvm>[]) {
      client.sample = sickSample(client.url, { chainId: 84532, collateral: collateralOf(derived) });
    }
    const now = () => Number(sickSample('x').blockTimestamp) * 1000 + 2_000;

    const text = await describePosition(wiring, now);

    expect(text).toContain('Position 1 on base-sepolia, collateral mode');
    expect(text).toContain(`sells ${weth} through ${helper}, pool fee 500, slippage up to 100 bps`);
    expect(text).toContain('borrower holds 10 in aTokens, 10 approved to the helper');
    expect(text).toContain('would repay 5000 USDC, limited by max_per_rescue');
  });

  it('shows a helper that no longer agrees in status', async () => {
    const wiring = await wire();
    for (const client of wiring.clients as ReturnType<typeof fakeEvm>[]) {
      client.sample = sickSample(client.url, {
        chainId: 84532,
        collateral: collateralOf(derived, { triggerHf: parseWad('1.3') }),
      });
    }
    const now = () => Number(sickSample('x').blockTimestamp) * 1000 + 2_000;

    expect(await describePosition(wiring, now)).toContain('helper config differs: trigger');
  });
});

describe('replaying a collateral run', () => {
  let h: Harness;
  afterEach(() => h?.cleanup());

  const record = async (): Promise<RunRecord> => {
    const result = await tick(h.ctx);
    if (result.status !== 'recorded') throw new Error(`expected a record, got ${result.status}`);
    return result.run;
  };
  const clone = (run: RunRecord): RunRecord => JSON.parse(JSON.stringify(run));
  const mismatched = async (run: RunRecord) =>
    (await replayRun(run)).steps.filter((step) => step.ok === false).map((step) => step.title);

  it('recomputes every step, the swap included', async () => {
    h = await collateralHarness();

    const result = await replayRun(await record());

    expect(result.ok).toBe(true);
    expect(result.steps.map((step) => step.title)).toEqual([
      expect.stringMatching(/^Run /),
      'Quorum',
      'Decision',
      'Fees',
      'Quote',
      'NEAR rescue',
      'Signature',
      'Broadcast',
      'Receipt',
      'Swap',
      'Timeline',
    ]);
    expect(result.steps[0]?.lines.join(' ')).toContain('collateral mode');
    const swap = result.steps.find((step) => step.title === 'Swap');
    expect(swap?.lines.join(' ')).toContain('29 bps below');
  });

  it('reproduces an above-trigger revert as the no-op it was', async () => {
    h = await collateralHarness();
    for (const client of [h.a, h.b]) {
      client.receipt = { success: false, blockNumber: 1_001n, gasUsed: 1n, effectiveGasPrice: 1n };
      client.simulation = { reverted: true, data: ABOVE_TRIGGER_SELECTOR, error: 'reverted' };
    }

    const result = await replayRun(await record());

    expect(result.ok).toBe(true);
    expect(result.steps.find((step) => step.title === 'Revert')?.ok).toBe(true);
  });

  it('catches an edited amount sold', async () => {
    h = await collateralHarness();
    const run = clone(await record());
    run.sold = '1';
    expect(await mismatched(run)).toEqual(['Swap']);
  });

  it('catches an edited price', async () => {
    h = await collateralHarness();
    const run = clone(await record());
    if (run.swap) run.swap.discount_bps = '0';
    expect(await mismatched(run)).toEqual(['Swap']);
  });

  it('catches a revert relabelled as above the trigger', async () => {
    h = await collateralHarness();
    for (const client of [h.a, h.b]) {
      client.receipt = { success: false, blockNumber: 1_001n, gasUsed: 1n, effectiveGasPrice: 1n };
      client.simulation = { reverted: true, data: '0x08c379a0', error: 'slippage' };
    }
    const run = clone(await record());
    expect(run.failure_reason).toBe('evm_reverted: 0x08c379a0');

    run.outcome = 'aborted';
    run.failure_reason = 'above_trigger';

    expect(await mismatched(run)).toEqual(['Revert']);
  });

  it('recomputes max_sold from the recorded quotes', async () => {
    h = await collateralHarness();
    const result = await replayRun(await record());
    const quote = result.steps.find((step) => step.title === 'Quote');
    expect(quote?.ok).toBe(true);
    expect(quote?.lines.join(' ')).toContain('max_sold 2520037500000000000');
  });

  it('catches an edited max_sold', async () => {
    h = await collateralHarness();
    const run = clone(await record());
    run.max_sold = '9999999999999999999';
    expect(await mismatched(run)).toEqual(['Quote', 'Signature']);
  });

  it('catches an edited quote', async () => {
    h = await collateralHarness();
    const run = clone(await record());
    const answer = run.trace?.quote?.answers[0];
    if (answer) answer.amount_in = '2600000000000000000';
    expect(await mismatched(run)).toEqual(['Quote']);
  });

  it('catches an edited oracle bound', async () => {
    h = await collateralHarness();
    const run = clone(await record());
    if (run.trace?.quote) run.trace.quote.oracle_max_in = '1';
    expect(await mismatched(run)).toEqual(['Quote']);
  });

  it('repeats a refusal to quote', async () => {
    h = await collateralHarness();
    h.b.quote = new Error('timeout');
    const run = await record();
    expect(run.failure_reason).toMatch(/^quote_unavailable/);
    const result = await replayRun(run);
    expect(result.ok).toBe(true);
    expect(result.steps.find((step) => step.title === 'Quote')?.lines.join(' ')).toContain(
      'refused: quote_unavailable',
    );
  });

  it('catches an edited fee tier', async () => {
    h = await collateralHarness();
    const run = clone(await record());
    if (run.trace?.collateral) run.trace.collateral.pool_fee = '3000';
    expect(await mismatched(run)).toEqual(expect.arrayContaining(['Signature']));
  });

  it('catches an edited setting at the helper', async () => {
    h = await collateralHarness();
    const run = clone(await record());
    for (const sample of run.trace?.quorum?.samples ?? []) {
      if (sample.collateral) sample.collateral.target_hf = parseWad('1.9').toString();
    }
    expect(await mismatched(run)).toEqual(['Decision']);
  });

  it('refuses to recompute a collateral run whose terms were removed', async () => {
    h = await collateralHarness();
    const run = clone(await record());
    if (run.trace) delete run.trace.collateral;
    expect(await mismatched(run)).toEqual(expect.arrayContaining(['Decision', 'Signature']));
  });
});

describe('verifying a collateral run', () => {
  const chain = CHAINS[84532] as NonNullable<(typeof CHAINS)[84532]>;
  const rescuer: Address = '0x3333333333333333333333333333333333333333';
  const amount = 2_500_000n;
  const sold = 1_250_000_000_000_000n;
  const maxSold = 1_256_250_000_000_000n;
  const evmHash: Hex = `0x${'ab'.repeat(32)}`;
  const call = { borrower, collateral: weth, amount, poolFee: 500n, maxSold };

  const onChainTx = (over: Partial<EvmTransaction> = {}): EvmTransaction => ({
    hash: evmHash,
    from: rescuer,
    to: helper,
    input: unwindCalldata(call),
    value: 0n,
    chainId: chain.chainId,
    nonce: 4,
    gas: 600_000n,
    maxFeePerGas: 2_100n,
    maxPriorityFeePerGas: 100n,
    type: 'eip1559',
    blockNumber: 99n,
    ...over,
  });

  const event = (over: Partial<Parameters<typeof unwoundLog>[0]> = {}) =>
    unwoundLog({ borrower, rescuer, collateral: weth, repaid: amount, sold, ...over });

  const receipt = (logs = [event()]): EvmReceipt => ({
    success: true,
    blockNumber: 99n,
    gasUsed: 1n,
    effectiveGasPrice: 1n,
    logs,
  });

  const nearStatus = (tx: EvmTransaction, over: Partial<NearTxStatus> = {}): NearTxStatus => ({
    success: true,
    failure: null,
    signerId: 'keeper.testnet',
    receiverId: 'levee.testnet',
    methodName: 'rescue_from_collateral',
    args: { id: 1, amount: amount.toString(), max_sold: maxSold.toString(), fees: {} },
    blockHash: 'Block',
    returnValue: {
      kind: 'unwind',
      id: 1,
      unsigned_tx: '02',
      tx_hash: signingHash(tx).slice(2),
      big_r: `02${'cd'.repeat(32)}`,
      s: '11'.repeat(32),
      recovery_id: 0,
    },
    ...over,
  });

  const run = (over: Partial<RunRecord> = {}): RunRecord => ({
    run_id: '2026-11-12T10-12-03Z-base-sepolia-1',
    network: 'testnet',
    position_id: 1,
    chain_id: chain.chainId,
    borrower,
    rescuer,
    amount: amount.toString(),
    outcome: 'success',
    failure_reason: null,
    health_factor_before: '1.19',
    health_factor_after: '1.3',
    timestamps_ms: { detected: 1, near_included: 2, signed: 3, broadcast: 4, included: 5 },
    near_tx: 'NearTxHash',
    evm_tx: evmHash,
    evm_block: 99,
    near_contract: 'levee.testnet',
    near_sender: 'keeper.testnet',
    mode: 'collateral',
    collateral: weth,
    max_sold: maxSold.toString(),
    sold: sold.toString(),
    swap: {
      repaid: amount.toString(),
      sold: sold.toString(),
      collateral_price_base: '200000000000',
      usdc_price_base: '100000000',
      effective_price_base: '200000000000',
      discount_bps: '0',
    },
    ...over,
  });

  interface World {
    tx: EvmTransaction;
    receipt: EvmReceipt | null;
    near: NearTxStatus;
    unwind: string | undefined;
    collateral: { asset: string; pool_fee: number } | null;
  }

  const world = (over: Partial<World> = {}): World => {
    const tx = over.tx ?? onChainTx();
    return {
      tx,
      receipt: receipt(),
      near: nearStatus(tx),
      unwind: helper,
      collateral: { asset: weth, pool_fee: 500 },
      ...over,
    };
  };

  const lookups = (state: World): Lookups => ({
    chain: () => ({
      transaction: async () => state.tx,
      receipt: async () => state.receipt,
    }),
    near: () => ({
      transaction: async () => state.near,
      position: async () => ({
        position: openPosition({ chain_id: chain.chainId, collateral: state.collateral }),
        asOf: 'block',
      }),
      rescuerAddress: async () => rescuer,
      chain: async () => ({
        chain_id: chain.chainId,
        pool: chain.pool,
        usdc: chain.usdc,
        ...(state.unwind ? { unwind: state.unwind } : {}),
      }),
    }),
  });

  const failed = async (record: RunRecord, state: World) => {
    const verdict = await verifyRun(record, lookups(state));
    return verdict.checks.filter((check) => !check.ok).map((check) => check.name);
  };

  it('passes when every check holds, the Unwound event included', async () => {
    const verdict = await verifyRun(run(), lookups(world()));

    expect(verdict.checks.filter((check) => !check.ok)).toEqual([]);
    expect(verdict.verdict).toBe('PASS');
    expect(verdict.checks.map((check) => check.name)).toEqual(
      expect.arrayContaining([
        'near_method',
        'near_kind',
        'evm_to',
        'selector',
        'borrower',
        'collateral',
        'collateral_registered',
        'pool_fee',
        'max_sold',
        'near_max_sold',
        'amount_within_caps',
        'unwound_event',
        'unwound_sold',
        'unwound_within_max_sold',
        'unwound_rescuer',
        'near_signed_evm_tx',
      ]),
    );
  });

  const changedTx = (over: Partial<EvmTransaction>) => {
    const tx = onChainTx(over);
    return world({ tx, near: nearStatus(tx) });
  };

  it.each<[string, World, string[]]>([
    ['another target', changedTx({ to: stranger }), ['evm_to']],
    [
      'a repay instead of an unwind',
      changedTx({ to: helper, input: repayCalldata(chain.usdc, amount, 2n, borrower) }),
      ['selector', 'unwind_args'],
    ],
    ['another borrower', changedTx({ input: unwindCalldata({ ...call, borrower: stranger }) }), ['borrower']],
    [
      'another collateral',
      changedTx({ input: unwindCalldata({ ...call, collateral: stranger }) }),
      ['collateral', 'collateral_registered'],
    ],
    ['another fee tier', changedTx({ input: unwindCalldata({ ...call, poolFee: 3_000n }) }), ['pool_fee']],
    [
      'a looser max_sold than the record',
      changedTx({ input: unwindCalldata({ ...call, maxSold: maxSold + 1n }) }),
      ['max_sold'],
    ],
  ])('fails on %s', async (_name, state, expected) => {
    expect(await failed(run(), state)).toEqual(expected);
  });

  it('fails when the NEAR call asked for another max_sold', async () => {
    const state = world();
    state.near = {
      ...state.near,
      args: { ...(state.near.args as object), max_sold: (maxSold * 2n).toString() },
    };
    expect(await failed(run(), state)).toEqual(['near_max_sold']);
  });

  it('fails a collateral record with no max_sold', async () => {
    expect(await failed(run({ max_sold: null }), world())).toEqual([
      'near_max_sold',
      'max_sold',
      'unwound_within_max_sold',
    ]);
  });

  /** The helper refuses such a sale, so a record of one is not to be believed. */
  it('fails when the event sold more than the max_sold signed', async () => {
    const tight = sold - 1n;
    const state = changedTx({ input: unwindCalldata({ ...call, maxSold: tight }) });
    state.near = {
      ...state.near,
      args: { ...(state.near.args as object), max_sold: tight.toString() },
    };
    expect(await failed(run({ max_sold: tight.toString() }), state)).toEqual([
      'unwound_within_max_sold',
    ]);
  });

  it('fails when the NEAR call was rescue rather than rescue_from_collateral', async () => {
    const state = world();
    state.near = { ...state.near, methodName: 'rescue' };
    expect(await failed(run(), state)).toEqual(['near_method']);
  });

  it('fails when the contract signed a rescue, not an unwind', async () => {
    const state = world();
    state.near = {
      ...state.near,
      returnValue: { ...(state.near.returnValue as object), kind: 'rescue' },
    };
    expect(await failed(run(), state)).toEqual(['near_kind']);
  });

  it('fails when the contract names no helper, or another one', async () => {
    expect(await failed(run(), world({ unwind: undefined }))).toEqual(['evm_to']);
    // The event came from the real helper, so it does not count for the one named.
    expect(await failed(run(), world({ unwind: stranger }))).toEqual(['evm_to', 'unwound_event']);
  });

  it('fails when the position has no collateral config', async () => {
    expect(await failed(run(), world({ collateral: null }))).toEqual(['collateral_registered']);
  });

  it('fails when the position registered another fee tier', async () => {
    expect(await failed(run(), world({ collateral: { asset: weth, pool_fee: 3_000 } }))).toEqual([
      'pool_fee',
    ]);
  });

  it('fails a success with no Unwound event, or with two', async () => {
    expect(await failed(run(), world({ receipt: receipt([]) }))).toEqual(['unwound_event']);
    expect(await failed(run(), world({ receipt: receipt([event(), event()]) }))).toEqual([
      'unwound_event',
    ]);
  });

  it('does not count an Unwound event from another contract', async () => {
    const forged = event({ address: stranger });
    expect(await failed(run(), world({ receipt: receipt([forged]) }))).toEqual(['unwound_event']);
  });

  it.each<[string, Partial<Parameters<typeof unwoundLog>[0]>, string[]]>([
    ['sold', { sold: sold + 1n }, ['unwound_sold', 'swap_sold']],
    ['rescuer', { rescuer: stranger }, ['unwound_rescuer']],
    ['borrower', { borrower: stranger }, ['unwound_borrower']],
    ['collateral', { collateral: stranger }, ['unwound_collateral']],
    ['repaid, above the amount signed', { repaid: amount + 1n }, ['unwound_repaid', 'swap_repaid']],
  ])('fails when the event disagrees on %s', async (_name, change, expected) => {
    expect(await failed(run(), world({ receipt: receipt([event(change)]) }))).toEqual(expected);
  });

  it('accepts a repay the helper capped below the amount, if the record says so', async () => {
    const capped = amount - 1n;
    const state = world({ receipt: receipt([event({ repaid: capped })]) });
    const record = run();
    if (record.swap) record.swap.repaid = capped.toString();
    expect(await failed(record, state)).toEqual([]);
  });

  it('records an above-trigger abort whose transaction checks out', async () => {
    const reverted = world({
      receipt: { success: false, blockNumber: 99n, gasUsed: 1n, effectiveGasPrice: 1n, logs: [] },
    });
    const record = run({ outcome: 'aborted', failure_reason: 'above_trigger', sold: null, swap: null });

    const verdict = await verifyRun(record, lookups(reverted));

    expect(verdict.verdict).toBe('RECORDED');
    expect(verdict.checks.filter((check) => !check.ok)).toEqual([]);
  });

  it('still checks what an aborted run put on chain', async () => {
    const state = changedTx({ to: stranger });
    const record = run({ outcome: 'aborted', failure_reason: 'above_trigger', sold: null, swap: null });
    expect((await verifyRun(record, lookups(state))).verdict).toBe('FAIL');
  });
});
