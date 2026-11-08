import type { Address } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { parseWad } from '../src/decision.js';
import { RESCUE_METHODS } from '../src/near.js';
import { type TickResult, tick } from '../src/rescue.js';
import { ABOVE_TRIGGER_SELECTOR, decodeUnwind } from '../src/unwind.js';
import {
  COLLATERAL_SALE,
  type Harness,
  borrower,
  chain,
  collateralHarness,
  collateralOf,
  fakeNear,
  helper,
  sickSample,
  unwoundLog,
  weth,
} from './support/fakes.js';
import { createSimulatedMpc, repayCalldata } from './support/simulated-mpc.js';
import { parseTransaction, parseTransactionKeccak } from './support/tx.js';

let h: Harness;

afterEach(() => h?.cleanup());

const recorded = (result: TickResult) => {
  if (result.status !== 'recorded') throw new Error(`expected a record, got ${result.status}`);
  return result.run;
};

const expectNothingOnEitherChain = () => {
  expect(h.near.requests).toEqual([]);
  expect(h.a.broadcasts).toEqual([]);
  expect(h.b.broadcasts).toEqual([]);
};

/** Gives both endpoints the same collateral reading. */
const setCollateral = (over: Parameters<typeof collateralOf>[1]) => {
  for (const client of [h.a, h.b]) {
    client.sample = sickSample(client.url, { collateral: collateralOf(h.mpc.address, over) });
  }
};

const MAX_PER_RESCUE = 5_000n * 10n ** 6n;

describe('a rescue from collateral that works', () => {
  it('asks the contract for rescue_from_collateral, capped by max_per_rescue', async () => {
    h = await collateralHarness();

    await tick(h.ctx);

    const [request] = h.near.requests;
    // The target needs $8,084.89, and the position allows $5,000 a rescue.
    expect(request).toMatchObject({ id: 1, amount: MAX_PER_RESCUE, mode: 'collateral' });
    expect(RESCUE_METHODS.collateral).toBe('rescue_from_collateral');
  });

  it('broadcasts an unwind on the helper with the position’s own terms', async () => {
    h = await collateralHarness();

    await tick(h.ctx);

    expect(h.a.broadcasts).toHaveLength(1);
    expect(h.a.broadcasts).toEqual(h.b.broadcasts);
    const tx = parseTransaction(h.a.broadcasts[0]);
    expect(tx.to).toBe(helper.toLowerCase());
    expect(decodeUnwind(tx.data ?? '0x')).toEqual({
      borrower,
      collateral: weth,
      amount: MAX_PER_RESCUE,
      poolFee: 500n,
    });
  });

  it('records the mode, the collateral, what was sold and the price', async () => {
    h = await collateralHarness();

    const run = recorded(await tick(h.ctx));

    expect(run).toMatchObject({
      outcome: 'success',
      mode: 'collateral',
      collateral: weth,
      amount: MAX_PER_RESCUE.toString(),
      sold: COLLATERAL_SALE.sold.toString(),
      swap: {
        repaid: '5000000000',
        sold: '2507500000000000000',
        collateral_price_base: '200000000000',
        usdc_price_base: '100000000',
        effective_price_base: '199401794616',
        discount_bps: '29',
      },
    });
    expect(run.evm_tx).toBe(parseTransactionKeccak(h.a.broadcasts[0]));
    expect(run.trace?.collateral).toEqual({ asset: weth, helper, pool_fee: '500' });
    expect(run.trace?.unwound?.decimals).toBe('18');
    expect(run.trace?.decision).toMatchObject({ limited_by: 'max_per_rescue' });
  });

  it('needs no USDC and no allowance at the rescuer, only gas', async () => {
    h = await collateralHarness();
    for (const client of [h.a, h.b]) {
      client.sample = sickSample(client.url, {
        rescuerUsdc: 0n,
        rescuerAllowance: 0n,
        collateral: collateralOf(h.mpc.address),
      });
    }

    const run = recorded(await tick(h.ctx));

    expect(run.outcome).toBe('success');
  });

  it('repays what the target needs when the caps allow it', async () => {
    h = await collateralHarness({
      views: {
        getPosition: async () => ({
          ...(await import('./support/fakes.js')).openPosition(),
          max_per_rescue: 10_000n * 10n ** 6n,
        }),
      },
    });

    await tick(h.ctx);

    // R = 6,400 / (1.6 − 0.8 × 1.0105): 8,084,891,362 units. See collateral-decision.test.ts.
    expect(h.near.requests[0]?.amount).toBe(8_084_891_362n);
  });
});

describe('the borrower’s settings at the helper', () => {
  it('stay idle above the helper’s trigger', async () => {
    h = await collateralHarness();
    for (const client of [h.a, h.b]) {
      client.sample = sickSample(client.url, {
        healthFactor: parseWad('1.3'),
        collateral: collateralOf(h.mpc.address),
      });
    }

    const result = await tick(h.ctx);

    expect(result).toMatchObject({ status: 'idle', reason: 'healthy' });
    expectNothingOnEitherChain();
  });

  it.each<[string, Parameters<typeof collateralOf>[1]]>([
    ['a different trigger', { triggerHf: parseWad('1.3') }],
    ['a different target', { targetHf: parseWad('1.5') }],
    ['a different slippage limit', { maxSlippageBps: 300n }],
    ['another rescuer', { authorizedRescuer: '0x4444444444444444444444444444444444444444' }],
    ['a revoked rescuer', { authorizedRescuer: `0x${'00'.repeat(20)}` as Address }],
  ])('stop the keeper on %s, before NEAR is asked', async (_name, change) => {
    h = await collateralHarness();
    setCollateral(change);

    const run = recorded(await tick(h.ctx));

    expect(run.outcome).toBe('aborted');
    expect(run.failure_reason).toMatch(/^helper_config_mismatch: /);
    expectNothingOnEitherChain();
  });

  it('must agree across endpoints, or the quorum refuses', async () => {
    h = await collateralHarness();
    h.b.sample = sickSample(h.b.url, {
      collateral: collateralOf(h.mpc.address, { triggerHf: parseWad('1.3') }),
    });

    const run = recorded(await tick(h.ctx));

    expect(run.failure_reason).toMatch(/^quorum_disagreement: collateral.triggerHf differs/);
    expectNothingOnEitherChain();
  });

  it('refuses to act when the collateral was not read', async () => {
    h = await collateralHarness();
    h.a.sample = sickSample(h.a.url);
    h.b.sample = sickSample(h.b.url);

    const run = recorded(await tick(h.ctx));

    expect(run.failure_reason).toBe('collateral_unavailable');
    expectNothingOnEitherChain();
  });
});

describe('collateral caps', () => {
  it('record a borrower with no collateral left', async () => {
    h = await collateralHarness();
    setCollateral({ aTokenBalance: 0n });

    const run = recorded(await tick(h.ctx));

    expect(run).toMatchObject({ outcome: 'aborted', failure_reason: 'no_collateral' });
    expectNothingOnEitherChain();
  });

  it('record a borrower who approved nothing to the helper', async () => {
    h = await collateralHarness();
    setCollateral({ aTokenAllowance: 0n });

    const run = recorded(await tick(h.ctx));

    expect(run).toMatchObject({ outcome: 'aborted', failure_reason: 'no_collateral_allowance' });
    expectNothingOnEitherChain();
  });

  it('cap the amount at what the allowance can pay for', async () => {
    h = await collateralHarness();
    setCollateral({ aTokenAllowance: 10n ** 18n });

    await tick(h.ctx);

    // 1 WETH at $2,000, divided by 1.0105.
    expect(h.near.requests[0]?.amount).toBe(1_979_218_208n);
  });

  it('veto a rescue when endpoints disagree on the collateral price', async () => {
    h = await collateralHarness();
    h.b.sample = sickSample(h.b.url, {
      collateral: collateralOf(h.mpc.address, { priceBase: 1_900n * 10n ** 8n }),
    });

    const run = recorded(await tick(h.ctx));

    expect(run.failure_reason).toMatch(/^quorum_disagreement: collateral.priceBase/);
    expectNothingOnEitherChain();
  });
});

describe('the broadcast gate in collateral mode', () => {
  it('refuses a signature from any key but the derived rescuer', async () => {
    h = await collateralHarness();
    h.ctx.near = fakeNear(createSimulatedMpc());

    const run = recorded(await tick(h.ctx));

    expect(run.failure_reason).toMatch(/^signer_mismatch/);
    expect(h.a.broadcasts).toEqual([]);
  });

  it.each<[string, (fields: { to: Address; data: `0x${string}` }) => void]>([
    ['the Pool as target', (fields) => { fields.to = chain.pool; }],
    [
      'a repay instead of an unwind',
      (fields) => { fields.data = repayCalldata(chain.usdc, MAX_PER_RESCUE, 2n, borrower); },
    ],
  ])('refuses %s', async (_name, tamper) => {
    h = await collateralHarness();
    h.ctx.near = fakeNear(h.mpc, { tamper });

    const run = recorded(await tick(h.ctx));

    expect(run.failure_reason).toMatch(/^intent_mismatch/);
    expect(h.a.broadcasts).toEqual([]);
  });

  it.each([
    ['another collateral', { collateral: '0x4444444444444444444444444444444444444444' as Address }],
    ['another fee tier', { poolFee: 3_000n }],
    ['another borrower', { borrower: '0x4444444444444444444444444444444444444444' as Address }],
  ])('refuses %s in the calldata', async (_name, behaviour) => {
    h = await collateralHarness();
    h.ctx.near = fakeNear(h.mpc, behaviour);

    const run = recorded(await tick(h.ctx));

    expect(run.failure_reason).toMatch(/^intent_mismatch/);
    expect(h.a.broadcasts).toEqual([]);
  });
});

describe('an unwind that reverts', () => {
  const reverted = { success: false, blockNumber: 1_001n, gasUsed: 90_000n, effectiveGasPrice: 2_000n };

  it('is a no-op abort when the health factor recovered above the trigger', async () => {
    h = await collateralHarness();
    for (const client of [h.a, h.b]) {
      client.receipt = reverted;
      client.simulation = { reverted: true, data: ABOVE_TRIGGER_SELECTOR, error: 'reverted' };
    }

    const run = recorded(await tick(h.ctx));

    expect(run).toMatchObject({ outcome: 'aborted', failure_reason: 'above_trigger', evm_block: 1001 });
    expect(run.evm_tx).not.toBeNull();
    expect(run.sold).toBeNull();
    expect(run.trace?.revert).toEqual({ data: ABOVE_TRIGGER_SELECTOR, error: 'reverted' });
  });

  it('is never quietened, because gas was spent', async () => {
    h = await collateralHarness({ allowAbortRecord: () => false });
    for (const client of [h.a, h.b]) {
      client.receipt = reverted;
      client.simulation = { reverted: true, data: ABOVE_TRIGGER_SELECTOR, error: 'reverted' };
    }

    const result = await tick(h.ctx);

    expect(result.status).toBe('recorded');
  });

  it('is a failure for any other reason, with the error selector', async () => {
    h = await collateralHarness();
    for (const client of [h.a, h.b]) {
      client.receipt = reverted;
      client.simulation = { reverted: true, data: '0x08c379a0abcd', error: 'too much slippage' };
    }

    const run = recorded(await tick(h.ctx));

    expect(run).toMatchObject({ outcome: 'failed', failure_reason: 'evm_reverted: 0x08c379a0' });
  });

  it('is a failure when the reason cannot be read again', async () => {
    h = await collateralHarness();
    for (const client of [h.a, h.b]) {
      client.receipt = reverted;
      client.simulation = new Error('eth_call is not served here');
    }

    const run = recorded(await tick(h.ctx));

    expect(run).toMatchObject({ outcome: 'failed', failure_reason: 'evm_reverted' });
    expect(run.trace?.revert).toBeNull();
  });

  it('is a failure when the call no longer reverts at its block', async () => {
    h = await collateralHarness();
    for (const client of [h.a, h.b]) client.receipt = reverted;

    const run = recorded(await tick(h.ctx));

    expect(run.outcome).toBe('failed');
    expect(run.failure_reason).toContain('no longer reverts');
  });
});

describe('the helper’s event', () => {
  it('leaves sold empty when the receipt has none, so verify can catch it', async () => {
    h = await collateralHarness();
    for (const client of [h.a, h.b]) {
      client.receipt = { success: true, blockNumber: 1_001n, gasUsed: 1n, effectiveGasPrice: 1n, logs: [] };
    }

    const run = recorded(await tick(h.ctx));

    expect(run).toMatchObject({ outcome: 'success', sold: null, swap: null });
  });

  it('ignores an Unwound from any other contract', async () => {
    h = await collateralHarness();
    const forged = unwoundLog({
      borrower,
      rescuer: h.mpc.address,
      collateral: weth,
      repaid: 1n,
      sold: 1n,
      address: '0x4444444444444444444444444444444444444444',
    });
    for (const client of [h.a, h.b]) {
      client.receipt = { success: true, blockNumber: 1_001n, gasUsed: 1n, effectiveGasPrice: 1n, logs: [forged] };
    }

    const run = recorded(await tick(h.ctx));

    expect(run.sold).toBeNull();
  });

  it('keeps what was sold when the oracle cannot be read at that block', async () => {
    h = await collateralHarness();
    h.a.prices = new Error('pruned');
    h.b.prices = new Error('pruned');

    const run = recorded(await tick(h.ctx));

    expect(run).toMatchObject({ outcome: 'success', sold: COLLATERAL_SALE.sold.toString(), swap: null });
    expect(run.trace?.unwound).toMatchObject({ collateral_price_base: null, usdc_price_base: null });
  });
});

describe('a reserve run, by contrast', () => {
  it('says reserve and carries no collateral fields', async () => {
    const { harness } = await import('./support/fakes.js');
    h = await harness();

    const run = recorded(await tick(h.ctx));

    expect(run.mode).toBe('reserve');
    expect(run).not.toHaveProperty('collateral');
    expect(run).not.toHaveProperty('sold');
    expect(run.trace).not.toHaveProperty('unwound');
    expect(h.near.requests[0]?.mode).toBeUndefined();
  });
});
