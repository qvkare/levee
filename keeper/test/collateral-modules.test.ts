/**
 * Collateral mode in the smaller modules: the positions file, the quorum, the record
 * format, the broadcast gate and the EVM reads behind the revert check.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Address, encodeErrorResult, parseAbi } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REPO_ROOT, parsePositionsFile } from '../src/config.js';
import { parseWad } from '../src/decision.js';
import {
  modeOf,
  parseRun,
  readRunFile,
  sampleFromTrace,
  sampleToTrace,
} from '../src/evidence.js';
import { createEvmClient } from '../src/evm.js';
import { DEFAULT_QUORUM, evaluateQuorum } from '../src/quorum.js';
import {
  SignatureRefused,
  type UnwindIntent,
  assembleSignedTransaction,
  assertMatchesUnwindIntent,
} from '../src/signature.js';
import { ABOVE_TRIGGER_ERROR, ABOVE_TRIGGER_SELECTOR, isAboveTrigger, unwindCalldata } from '../src/unwind.js';
import {
  borrower,
  chain,
  collateralOf,
  helper,
  nowMs,
  sickSample,
  unwoundLog,
  weth,
} from './support/fakes.js';
import { createSimulatedMpc, repayCalldata, unsignedTransaction } from './support/simulated-mpc.js';

const rescuer: Address = '0x3333333333333333333333333333333333333333';
const stranger: Address = '0x4444444444444444444444444444444444444444';

afterEach(() => vi.unstubAllGlobals());

describe('the positions file', () => {
  const file = (entry: Record<string, unknown>) =>
    JSON.stringify({
      positions: [{ id: 1, trigger: '1.25', target: '1.6', ...entry }],
      fee_ceilings: {},
    });

  it('reads a collateral position with its slippage limit and the default quote tolerance', () => {
    const { positions } = parsePositionsFile(file({ mode: 'collateral', max_slippage_bps: 100 }));
    expect(positions[0]).toEqual({
      id: 1,
      trigger: '1.25',
      target: '1.6',
      triggerWad: parseWad('1.25'),
      targetWad: parseWad('1.6'),
      mode: 'collateral',
      maxSlippageBps: 100n,
      quoteToleranceBps: 50n,
    });
  });

  it.each([0, 1, 300])('reads a quote tolerance of %s bps', (bps) => {
    const entry = { mode: 'collateral', max_slippage_bps: 100, quote_tolerance_bps: bps };
    expect(parsePositionsFile(file(entry)).positions[0]?.quoteToleranceBps).toBe(BigInt(bps));
  });

  it.each([-1, 301])('refuses a quote tolerance of %s bps', (bps) => {
    const entry = { mode: 'collateral', max_slippage_bps: 100, quote_tolerance_bps: bps };
    expect(() => parsePositionsFile(file(entry))).toThrow(/quote_tolerance_bps must be from 0 to 300/);
  });

  it('refuses a quote tolerance on a reserve position', () => {
    expect(() => parsePositionsFile(file({ quote_tolerance_bps: 50 }))).toThrow(/only to mode/);
  });

  it('keeps a position with no mode in reserve mode, as before', () => {
    expect(parsePositionsFile(file({})).positions[0]?.mode).toBeUndefined();
    expect(parsePositionsFile(file({ mode: 'reserve' })).positions[0]?.mode).toBeUndefined();
  });

  it.each([undefined, 0, -1, 301])('refuses collateral mode with a slippage limit of %s', (bps) => {
    const entry = { mode: 'collateral', ...(bps === undefined ? {} : { max_slippage_bps: bps }) };
    expect(() => parsePositionsFile(file(entry))).toThrow(/max_slippage_bps above 0 and at most 300/);
  });

  it('accepts the helper’s largest slippage limit', () => {
    const { positions } = parsePositionsFile(file({ mode: 'collateral', max_slippage_bps: 300 }));
    expect(positions[0]?.maxSlippageBps).toBe(300n);
  });

  it('refuses a slippage limit on a reserve position, where it would mean nothing', () => {
    expect(() => parsePositionsFile(file({ max_slippage_bps: 100 }))).toThrow(/only to mode/);
  });

  it('refuses an unknown mode', () => {
    expect(() => parsePositionsFile(file({ mode: 'flash' }))).toThrow();
  });

  it('accepts the example shipped with the package, which uses collateral mode', async () => {
    const example = await readFile(join(REPO_ROOT, 'keeper/positions.example.json'), 'utf8');
    expect(parsePositionsFile(example).positions.some((p) => p.mode === 'collateral')).toBe(true);
  });
});

describe('the quorum in collateral mode', () => {
  const options = { ...DEFAULT_QUORUM, chainId: 8453, nowMs };
  const withCollateral = (rpc: string, over: Parameters<typeof collateralOf>[1] = {}) =>
    sickSample(rpc, { collateral: collateralOf(rescuer, over) });

  it('accepts endpoints that agree', () => {
    expect(evaluateQuorum([withCollateral('a'), withCollateral('b')], [], options).ok).toBe(true);
  });

  it('allows the usual 0.5% on prices and balances', () => {
    const price = 2_000n * 10n ** 8n;
    const result = evaluateQuorum(
      [withCollateral('a'), withCollateral('b', { priceBase: price - price / 200n })],
      [],
      options,
    );
    expect(result.ok).toBe(true);
  });

  it.each<[string, Parameters<typeof collateralOf>[1]]>([
    ['price', { priceBase: 1_980n * 10n ** 8n }],
    ['threshold', { liquidationThresholdBps: 7_000n }],
    ['aToken balance', { aTokenBalance: 1n }],
    ['allowance', { aTokenAllowance: 1n }],
  ])('refuses a %s beyond 0.5%', (_name, over) => {
    const result = evaluateQuorum([withCollateral('a'), withCollateral('b', over)], [], options);
    expect(result).toMatchObject({ ok: false, reason: 'disagreement' });
  });

  it.each<[string, Parameters<typeof collateralOf>[1]]>([
    ['trigger', { triggerHf: parseWad('1.25') + 1n }],
    ['target', { targetHf: parseWad('1.6') + 1n }],
    ['slippage', { maxSlippageBps: 101n }],
    ['rescuer', { authorizedRescuer: stranger }],
    ['decimals', { decimals: 8n }],
    ['authorized collateral', { authorizedCollateral: stranger }],
    ['authorized pool fee', { authorizedPoolFee: 3_000n }],
  ])('refuses any difference in the %s setting', (_name, over) => {
    const result = evaluateQuorum([withCollateral('a'), withCollateral('b', over)], [], options);
    expect(result).toMatchObject({ ok: false, reason: 'disagreement' });
  });

  it('compares the rescuer in any case', () => {
    const upper = rescuer.toUpperCase().replace('0X', '0x') as Address;
    const result = evaluateQuorum(
      [withCollateral('a'), withCollateral('b', { authorizedRescuer: upper })],
      [],
      options,
    );
    expect(result.ok).toBe(true);
  });

  it('refuses when only some endpoints read the collateral', () => {
    const result = evaluateQuorum([withCollateral('a'), sickSample('b')], [], options);
    expect(result).toMatchObject({ ok: false, reason: 'disagreement' });
    if (!result.ok) expect(result.detail).toContain('some endpoints only');
  });
});

describe('the record format', () => {
  it('reads a record with no mode as reserve, so every v0.1 record stays valid', async () => {
    const run = await readRunFile(
      join(REPO_ROOT, 'evidence/runs/2026-11-07T19-23-34Z-base-sepolia-1.json'),
    );
    expect(run.mode).toBeUndefined();
    expect(modeOf(run)).toBe('reserve');
  });

  it('keeps a collateral sample through the trace', () => {
    const sample = sickSample('a', { collateral: collateralOf(rescuer) });
    expect(sampleFromTrace(sampleToTrace(sample))).toEqual(sample);
  });

  it('reads a collateral sample from before authorize named the collateral', () => {
    const trace = sampleToTrace(sickSample('a', { collateral: collateralOf(rescuer) }));
    const { authorized_collateral, authorized_pool_fee, ...older } =
      trace.collateral as NonNullable<typeof trace.collateral>;
    const sample = sampleFromTrace({ ...trace, collateral: older });
    expect(sample.collateral).toMatchObject({
      authorizedCollateral: `0x${'00'.repeat(20)}`,
      authorizedPoolFee: 0n,
    });
  });

  it('leaves the collateral out of a reserve sample', () => {
    expect(sampleToTrace(sickSample('a'))).not.toHaveProperty('collateral');
  });

  const collateralRun = {
    run_id: 'r',
    network: 'testnet',
    position_id: 1,
    chain_id: 84532,
    borrower,
    rescuer,
    amount: '5000000000',
    outcome: 'success',
    failure_reason: null,
    health_factor_before: '1.1',
    health_factor_after: '1.3',
    timestamps_ms: { detected: 0, near_included: 0, signed: 0, broadcast: 0, included: 0 },
    near_tx: 'n',
    evm_tx: '0xabc',
    evm_block: 1,
    near_contract: 'levee.testnet',
    near_sender: 'keeper.testnet',
    mode: 'collateral',
    collateral: weth,
    max_sold: '2520037500000000000',
    sold: '2507500000000000000',
    swap: {
      repaid: '5000000000',
      sold: '2507500000000000000',
      collateral_price_base: '200000000000',
      usdc_price_base: '100000000',
      effective_price_base: '199401794616',
      discount_bps: '-3',
    },
  };

  it('accepts a collateral record, including a sale above the oracle', () => {
    expect(parseRun(JSON.stringify(collateralRun)).swap?.discount_bps).toBe('-3');
  });

  it('refuses a mode it does not know, and a sold amount that is not a number', () => {
    expect(() => parseRun(JSON.stringify({ ...collateralRun, mode: 'flash' }))).toThrow();
    expect(() => parseRun(JSON.stringify({ ...collateralRun, sold: '1.5' }))).toThrow();
    expect(() => parseRun(JSON.stringify({ ...collateralRun, max_sold: '-1' }))).toThrow();
  });
});

describe('assertMatchesUnwindIntent', () => {
  const mpc = createSimulatedMpc();
  const amount = 5_000_000_000n;
  const intent: UnwindIntent = {
    chainId: 8453,
    nonce: 3,
    maxFeePerGas: 1_000_000n,
    maxPriorityFeePerGas: 1_000n,
    helper,
    borrower,
    collateral: weth,
    poolFee: 500n,
    amount,
    maxSold: 2_520_037_500_000_000_000n,
    rescuer: mpc.address,
  };
  const call = { borrower, collateral: weth, amount, poolFee: 500n, maxSold: intent.maxSold };
  const fields = (over: Partial<Parameters<typeof unsignedTransaction>[0]> = {}) => ({
    chainId: intent.chainId,
    nonce: intent.nonce,
    maxFeePerGas: intent.maxFeePerGas,
    maxPriorityFeePerGas: intent.maxPriorityFeePerGas,
    to: helper,
    data: unwindCalldata(call),
    ...over,
  });
  const reason = async (over: Parameters<typeof fields>[0], signer = mpc) => {
    const assembled = await assembleSignedTransaction(signer.sign(unsignedTransaction(fields(over)), 1, 'unwind'));
    try {
      assertMatchesUnwindIntent(assembled, intent);
      return 'passed';
    } catch (error) {
      if (error instanceof SignatureRefused) return error.reason;
      throw error;
    }
  };

  it('passes the unwind that was asked for', async () => {
    expect(await reason({})).toBe('passed');
  });

  it('refuses a signature from another key', async () => {
    expect(await reason({}, createSimulatedMpc())).toBe('signer_mismatch');
  });

  it.each<[string, Parameters<typeof fields>[0]]>([
    ['another target', { to: stranger }],
    ['the Pool as target', { to: chain.pool }],
    ['another chain', { chainId: 42161 }],
    ['value attached', { value: 1n }],
    ['another nonce', { nonce: 4 }],
    ['a higher max fee', { maxFeePerGas: 2_000_000n }],
    ['a higher priority fee', { maxPriorityFeePerGas: 2_000n }],
    ['a repay instead', { data: repayCalldata(chain.usdc, amount, 2n, borrower) }],
    ['another borrower', { data: unwindCalldata({ ...call, borrower: stranger }) }],
    ['another collateral', { data: unwindCalldata({ ...call, collateral: stranger }) }],
    ['a larger amount', { data: unwindCalldata({ ...call, amount: amount + 1n }) }],
    ['another fee tier', { data: unwindCalldata({ ...call, poolFee: 3_000n }) }],
    ['a looser max_sold', { data: unwindCalldata({ ...call, maxSold: call.maxSold + 1n }) }],
    ['a tighter max_sold', { data: unwindCalldata({ ...call, maxSold: call.maxSold - 1n }) }],
    ['calldata that does not decode', { data: '0x65afae08' }],
    [
      'the old four-argument unwind',
      { data: `0xd0cda3c2${unwindCalldata(call).slice(10, 10 + 4 * 64)}` as const },
    ],
  ])('refuses %s', async (_name, over) => {
    expect(await reason(over)).toBe('intent_mismatch');
  });
});

describe('the EVM reads behind collateral mode', () => {
  /** A JSON-RPC endpoint answering from `handlers`, by method. */
  const rpc = (handlers: Record<string, (params: unknown[]) => unknown>) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        const { id, method, params } = JSON.parse(init.body);
        const handler = handlers[method];
        if (!handler) throw new Error(`unexpected RPC ${method}`);
        return new Response(JSON.stringify({ jsonrpc: '2.0', id, ...(handler(params) as object) }));
      }),
    );
  };
  const call = { from: rescuer, to: helper, data: '0xd0cda3c2' as const, gas: 600_000n };

  it('reads the revert data of a call replayed at its block', async () => {
    const data = encodeErrorResult({
      abi: parseAbi([`error ${ABOVE_TRIGGER_ERROR}`]),
      errorName: 'AboveTrigger',
      args: [1_250_000_000_000_000_000n, 1_200_000_000_000_000_000n],
    });
    let block: unknown;
    rpc({
      eth_call: (params) => {
        block = params[1];
        return { error: { code: 3, message: 'execution reverted', data } };
      },
    });

    const result = await createEvmClient('https://evm.invalid').simulate(call, 1_001n);

    expect(result).toMatchObject({ reverted: true, data });
    expect(isAboveTrigger(result.reverted ? result.data : null)).toBe(true);
    expect(data.startsWith(ABOVE_TRIGGER_SELECTOR)).toBe(true);
    expect(block).toBe('0x3e9');
  });

  it('says so when the call no longer reverts', async () => {
    rpc({ eth_call: () => ({ result: '0x' }) });
    const result = await createEvmClient('https://evm.invalid').simulate(call, 1n);
    expect(result).toEqual({ reverted: false });
  });

  it('keeps every log of a receipt', async () => {
    const log = unwoundLog({ borrower, rescuer, collateral: weth, repaid: 1n, sold: 2n });
    rpc({
      eth_getTransactionReceipt: () => ({
        result: {
          status: '0x1',
          blockNumber: '0x3e9',
          blockHash: `0x${'11'.repeat(32)}`,
          gasUsed: '0x1',
          cumulativeGasUsed: '0x1',
          effectiveGasPrice: '0x1',
          transactionHash: `0x${'22'.repeat(32)}`,
          transactionIndex: '0x0',
          from: rescuer,
          to: helper,
          contractAddress: null,
          logsBloom: `0x${'00'.repeat(256)}`,
          type: '0x2',
          logs: [
            {
              ...log,
              address: helper.toLowerCase(),
              blockNumber: '0x3e9',
              blockHash: `0x${'11'.repeat(32)}`,
              transactionHash: `0x${'22'.repeat(32)}`,
              transactionIndex: '0x0',
              logIndex: '0x0',
              removed: false,
            },
          ],
        },
      }),
    });

    const receipt = await createEvmClient('https://evm.invalid').readReceipt(`0x${'22'.repeat(32)}`);

    expect(receipt?.logs).toEqual([log]);
  });
});
