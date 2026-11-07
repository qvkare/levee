import { afterEach, describe, expect, it } from 'vitest';
import { parseWad } from '../src/decision.js';
import { NearRescueError } from '../src/near.js';
import { type RescueContext, type TickResult, tick } from '../src/rescue.js';
import { decodeRepay } from '../src/signature.js';
import {
  type Harness,
  borrower,
  chain,
  fakeEvm,
  fakeNear,
  harness,
  healthySample,
  nowMs,
  openPosition,
  sickSample,
} from './support/fakes.js';
import { createSimulatedMpc } from './support/simulated-mpc.js';
import { parseTransaction, parseTransactionKeccak } from './support/tx.js';

let h: Harness;

const setup = async (over: Partial<RescueContext> = {}) => {
  h = await harness(over);
  return h;
};

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

const expectNothingBroadcast = () => {
  expect(h.a.broadcasts).toEqual([]);
  expect(h.b.broadcasts).toEqual([]);
};

describe('a healthy position', () => {
  it('does nothing and records nothing', async () => {
    await setup();
    h.a.sample = healthySample(h.a.url);
    h.b.sample = healthySample(h.b.url);

    const result = await tick(h.ctx);

    expect(result).toMatchObject({ status: 'idle', reason: 'healthy' });
    expectNothingOnEitherChain();
    expect(await h.runFiles()).toEqual([]);
  });

  it('does not read NEAR, so an idle keeper costs no NEAR RPC calls', async () => {
    let reads = 0;
    await setup({
      views: {
        getPosition: async () => {
          reads += 1;
          return openPosition();
        },
      },
    });
    h.a.sample = healthySample(h.a.url);
    h.b.sample = healthySample(h.b.url);

    await tick(h.ctx);

    expect(reads).toBe(0);
  });
});

describe('a rescue that works', () => {
  it('asks the contract for the amount that reaches the target', async () => {
    await setup();

    await tick(h.ctx);

    const [request] = h.near.requests;
    // $14,000 of debt against 16,000 of weighted collateral, target 1.6: repay $4,000.
    expect(request?.amount).toBe(4_000n * 10n ** 6n + 2n);
    expect(request?.id).toBe(1);
    expect(request?.fees).toEqual({ nonce: 4, maxFeePerGas: 2_100n, maxPriorityFeePerGas: 100n });
  });

  it('broadcasts the same signed transaction to every RPC', async () => {
    await setup();

    await tick(h.ctx);

    expect(h.a.broadcasts).toHaveLength(1);
    expect(h.a.broadcasts).toEqual(h.b.broadcasts);
    const tx = parseTransaction(h.a.broadcasts[0]);
    expect(tx.to).toBe(chain.pool.toLowerCase());
    expect(decodeRepay(tx.data ?? '0x')?.onBehalfOf).toBe(borrower);
  });

  it('writes the record in the spec format', async () => {
    await setup();

    const run = recorded(await tick(h.ctx));

    expect(run).toMatchObject({
      network: 'simulated',
      position_id: 1,
      chain_id: 8453,
      borrower,
      rescuer: h.mpc.address,
      amount: '4000000002',
      outcome: 'success',
      failure_reason: null,
      health_factor_before: '1.142857',
      health_factor_after: '1.6',
      near_tx: 'SimulatedNearTxHash',
      evm_block: 1001,
      near_contract: 'levee.testnet',
      near_sender: 'keeper.testnet',
    });
    expect(run.run_id).toBe('2027-01-15T08-00-00Z-base-1');
    expect(run.evm_tx).toBe(parseTransactionKeccak(h.a.broadcasts[0]));
    expect(await h.runFiles()).toEqual([`${run.run_id}.json`]);
  });

  it('records a timestamp for each step', async () => {
    await setup();

    const { timestamps_ms: t } = recorded(await tick(h.ctx));

    expect(t).toEqual({
      detected: nowMs,
      near_included: nowMs + 1_000,
      signed: nowMs + 4_000,
      broadcast: nowMs,
      included: nowMs,
    });
  });

  it('still counts as a success when the health factor cannot be reread', async () => {
    await setup();
    h.a.healthAfter = new Error('down');
    h.b.healthAfter = new Error('down');

    const run = recorded(await tick(h.ctx));

    expect(run.outcome).toBe('success');
    expect(run.health_factor_after).toBeNull();
  });

  it('reports the no-debt sentinel after clearing all debt', async () => {
    await setup();
    h.a.healthAfter = 2n ** 256n - 1n;

    const run = recorded(await tick(h.ctx));

    expect(run.health_factor_after).toBe('no_debt');
  });
});

describe('quorum refusals', () => {
  it('records a disagreement and does not touch NEAR', async () => {
    await setup();
    h.b.sample = sickSample(h.b.url, { healthFactor: parseWad('1.3') });

    const run = recorded(await tick(h.ctx));

    expect(run.outcome).toBe('aborted');
    expect(run.failure_reason).toMatch(/^quorum_disagreement: healthFactor differs/);
    expect(run.amount).toBe('0');
    expect(run.trace?.quorum?.samples).toHaveLength(2);
    expectNothingOnEitherChain();
  });

  it('stays quiet when two endpoints disagree about a healthy position', async () => {
    await setup();
    h.a.sample = sickSample(h.a.url, { healthFactor: parseWad('1.9') });
    h.b.sample = sickSample(h.b.url, { healthFactor: parseWad('3') });

    const result = await tick(h.ctx);

    expect(result).toMatchObject({ status: 'idle', reason: 'quorum_disagreement' });
    expect(await h.runFiles()).toEqual([]);
  });

  it('records stale reads of a position below the trigger', async () => {
    await setup();
    const blockTimestamp = BigInt(nowMs / 1000 - 31);
    h.a.sample = sickSample(h.a.url, { blockTimestamp });
    h.b.sample = sickSample(h.b.url, { blockTimestamp });

    const run = recorded(await tick(h.ctx));

    expect(run.failure_reason).toMatch(/^quorum_stale/);
    expectNothingOnEitherChain();
  });

  it('records being blind, since a position may be dying unseen', async () => {
    await setup();
    h.a.sample = new Error('down');
    h.b.sample = new Error('down');

    const run = recorded(await tick(h.ctx));

    expect(run.failure_reason).toMatch(/^quorum_too_few_rpcs/);
    expect(run.trace?.quorum?.failures).toHaveLength(2);
    expectNothingOnEitherChain();
  });

  it('refuses one endpoint alone, however bad it says things are', async () => {
    await setup();
    h.b.sample = new Error('down');

    const run = recorded(await tick(h.ctx));

    expect(run.failure_reason).toMatch(/^quorum_too_few_rpcs/);
    expectNothingOnEitherChain();
  });

  it('keeps a repeating refusal out of the evidence when told to', async () => {
    await setup({ allowAbortRecord: () => false });
    h.b.sample = new Error('down');

    const result = await tick(h.ctx);

    expect(result).toEqual({ status: 'quiet', reason: 'quorum_too_few_rpcs' });
    expect(await h.runFiles()).toEqual([]);
  });
});

describe('caps and contract state', () => {
  it('stops at a paused position and records it', async () => {
    await setup({ views: { getPosition: async () => openPosition({ paused: true }) } });

    const run = recorded(await tick(h.ctx));

    expect(run).toMatchObject({ outcome: 'aborted', failure_reason: 'paused' });
    expectNothingOnEitherChain();
  });

  it('waits out a cooldown quietly', async () => {
    const lastRescue = BigInt(nowMs - 60_000) * 1_000_000n;
    await setup({ views: { getPosition: async () => openPosition({ last_rescue_at: lastRescue }) } });

    const result = await tick(h.ctx);

    expect(result).toMatchObject({ status: 'idle', reason: 'cooldown' });
    expectNothingOnEitherChain();
  });

  it('records an empty rescuer, the reserve-empty failure the spec says to publish', async () => {
    await setup();
    h.a.sample = sickSample(h.a.url, { rescuerUsdc: 0n });
    h.b.sample = sickSample(h.b.url, { rescuerUsdc: 0n });

    const run = recorded(await tick(h.ctx));

    expect(run).toMatchObject({ outcome: 'aborted', failure_reason: 'rescuer_empty' });
    expectNothingOnEitherChain();
  });

  it('applies the daily budget the contract still has left', async () => {
    await setup({
      views: {
        getPosition: async () =>
          openPosition({ max_per_day: 3_000n * 10n ** 6n, spent_today: 2_000n * 10n ** 6n }),
      },
    });

    const run = recorded(await tick(h.ctx));

    expect(run.amount).toBe('1000000000');
    expect(run.trace?.decision).toMatchObject({ limited_by: 'max_per_day' });
  });

  it('records when the contract cannot be read', async () => {
    await setup({
      views: {
        getPosition: async () => {
          throw new Error('rpc down');
        },
      },
    });

    const run = recorded(await tick(h.ctx));

    expect(run.failure_reason).toBe('position_unavailable: rpc down');
    expectNothingOnEitherChain();
  });
});

describe('fees', () => {
  it('stops before NEAR when the base fee is above the ceiling', async () => {
    await setup({ ceilings: { maxFeePerGas: 999n, maxPriorityFeePerGas: 1_000n } });

    const run = recorded(await tick(h.ctx));

    expect(run.failure_reason).toMatch(/^fee_above_ceiling/);
    expect(run.amount).toBe('4000000002');
    expectNothingOnEitherChain();
  });

  it('stops before NEAR when no endpoint gives a nonce', async () => {
    await setup();
    const fail = async () => {
      throw new Error('down');
    };
    h.a.readNonce = fail;
    h.b.readNonce = fail;

    const run = recorded(await tick(h.ctx));

    expect(run.failure_reason).toBe('nonce_unavailable');
    expectNothingOnEitherChain();
  });
});

describe('NEAR failures', () => {
  it('records a failed rescue with its hash', async () => {
    await setup();
    h.ctx.near = fakeNear(h.mpc, {
      fail: new NearRescueError('near_failed', 'budget exceeded', 'FailedNearTx', 'keeper.testnet'),
    });

    const run = recorded(await tick(h.ctx));

    expect(run).toMatchObject({
      outcome: 'failed',
      failure_reason: 'near_failed: budget exceeded',
      near_tx: 'FailedNearTx',
      near_sender: 'keeper.testnet',
      evm_tx: null,
    });
    expectNothingBroadcast();
  });

  it('records an unexpected error from the NEAR client', async () => {
    await setup();
    h.ctx.near = fakeNear(h.mpc, { fail: new Error('socket hang up') });

    const run = recorded(await tick(h.ctx));

    expect(run).toMatchObject({ outcome: 'failed', failure_reason: 'near_failed: socket hang up' });
  });
});

describe('the broadcast gate', () => {
  it('refuses a signature from any key but the derived rescuer', async () => {
    await setup();
    h.ctx.near = fakeNear(createSimulatedMpc());

    const run = recorded(await tick(h.ctx));

    expect(run.outcome).toBe('aborted');
    expect(run.failure_reason).toMatch(/^signer_mismatch/);
    expect(run.near_tx).toBe('SimulatedNearTxHash');
    expect(run.evm_tx).toBeNull();
    expectNothingBroadcast();
  });

  it.each<[string, (fields: { to: `0x${string}`; nonce: number; value?: bigint }) => void]>([
    ['another target', (fields) => { fields.to = '0x2222222222222222222222222222222222222222'; }],
    ['another nonce', (fields) => { fields.nonce += 1; }],
    ['attached value', (fields) => { fields.value = 1n; }],
  ])('refuses %s even when correctly signed', async (_name, tamper) => {
    await setup();
    h.ctx.near = fakeNear(h.mpc, { tamper });

    const run = recorded(await tick(h.ctx));

    expect(run.outcome).toBe('aborted');
    expect(run.failure_reason).toMatch(/^intent_mismatch/);
    expectNothingBroadcast();
  });
});

describe('broadcast and receipt failures', () => {
  it('needs only one endpoint to accept the transaction', async () => {
    await setup();
    h.b.broadcastError = new Error('rate limited');

    const run = recorded(await tick(h.ctx));

    expect(run.outcome).toBe('success');
    expect(run.trace?.broadcast).toEqual([
      { rpc: h.a.url, ok: true, error: null },
      { rpc: h.b.url, ok: false, error: 'Error: rate limited' },
    ]);
  });

  it('counts already known as accepted, since gossip can beat the second send', async () => {
    await setup();
    h.a.broadcastError = Object.assign(new Error('x'), { details: 'already known' });
    h.b.broadcastError = Object.assign(new Error('x'), { details: 'already known' });

    const run = recorded(await tick(h.ctx));

    expect(run.outcome).toBe('success');
    expect(run.trace?.broadcast).toEqual([
      { rpc: h.a.url, ok: true, error: null },
      { rpc: h.b.url, ok: true, error: null },
    ]);
  });

  it('does not count an endpoint that reports a different hash', async () => {
    await setup();
    h.b.broadcast = async () => `0x${'00'.repeat(32)}`;

    const run = recorded(await tick(h.ctx));

    expect(run.outcome).toBe('success');
    expect(run.trace?.broadcast?.[1]).toMatchObject({
      rpc: h.b.url,
      ok: false,
      error: expect.stringContaining('returned hash'),
    });
  });

  it('fails when every endpoint reports a different hash and nothing lands', async () => {
    await setup();
    const lie = async (): Promise<`0x${string}`> => `0x${'00'.repeat(32)}`;
    h.a.broadcast = lie;
    h.b.broadcast = lie;
    h.a.receipt = null;
    h.b.receipt = null;

    const run = recorded(await tick(h.ctx));

    expect(run.outcome).toBe('failed');
    expect(run.failure_reason).toMatch(/^broadcast_rejected/);
  });

  it('fails when no endpoint accepts it and it has not landed', async () => {
    await setup();
    h.a.broadcastError = new Error('insufficient funds for gas');
    h.b.broadcastError = new Error('insufficient funds for gas');
    h.a.receipt = null;
    h.b.receipt = null;

    const run = recorded(await tick(h.ctx));

    expect(run.outcome).toBe('failed');
    expect(run.failure_reason).toMatch(/^broadcast_rejected: .*insufficient funds/);
    expect(run.evm_tx).not.toBeNull();
  });

  it('checks for a receipt anyway, in case every rejection was the transaction landing', async () => {
    await setup();
    h.a.broadcastError = new Error('nonce too low');
    h.b.broadcastError = new Error('nonce too low');

    const run = recorded(await tick(h.ctx));

    expect(run.outcome).toBe('success');
  });

  it('records a revert with the block it reverted in', async () => {
    await setup();
    const reverted = { success: false, blockNumber: 1_001n, gasUsed: 90_000n, effectiveGasPrice: 2_000n };
    h.a.receipt = reverted;
    h.b.receipt = reverted;

    const run = recorded(await tick(h.ctx));

    expect(run).toMatchObject({ outcome: 'failed', failure_reason: 'evm_reverted', evm_block: 1001 });
    expect(run.evm_tx).not.toBeNull();
    expect(run.health_factor_after).toBe('1.6');
  });

  it('gives up on a receipt at the deadline and keeps the hash', async () => {
    await setup();
    h.a.receipt = null;
    h.b.receipt = null;

    const run = recorded(await tick(h.ctx));

    expect(run).toMatchObject({ outcome: 'failed', failure_reason: 'receipt_timeout' });
    expect(run.evm_tx).not.toBeNull();
    expect(run.evm_block).toBeNull();
  });

  it('does not throttle a failure after the broadcast', async () => {
    await setup({ allowAbortRecord: () => false });
    h.a.receipt = null;
    h.b.receipt = null;

    expect((await tick(h.ctx)).status).toBe('recorded');
  });
});

describe('unexpected errors', () => {
  it('still leaves a record when a result is too malformed to keep in the trace', async () => {
    await setup();
    h.ctx.near = {
      rescue: async () => ({
        nearTx: 'NearTx',
        nearSender: 'keeper.testnet',
        includedAtMs: nowMs,
        signedAtMs: nowMs,
        result: {} as never,
      }),
    };

    const run = recorded(await tick(h.ctx));

    expect(run.outcome).toBe('failed');
    expect(run.failure_reason).toMatch(/^internal_error/);
    expect(run.near_tx).toBe('NearTx');
    expect(run.trace).toBeUndefined();
    expectNothingBroadcast();
  });
});

describe('firing early', () => {
  it('rescues above the trigger when given an amount', async () => {
    await setup();
    h.a.sample = healthySample(h.a.url);
    h.b.sample = healthySample(h.b.url);

    const run = recorded(await tick(h.ctx, { manualAmount: 1_000_000n }));

    expect(run).toMatchObject({ outcome: 'success', amount: '1000000' });
    expect(run.trace?.manual_amount).toBe('1000000');
  });

  it('cannot exceed the caps', async () => {
    await setup();

    const run = recorded(await tick(h.ctx, { manualAmount: 9_000_000n * 10n ** 6n }));

    expect(run.amount).toBe('5000000000');
  });

  it('cannot run without quorum', async () => {
    await setup();
    h.a.sample = healthySample(h.a.url);
    h.b.sample = new Error('down');

    const run = recorded(await tick(h.ctx, { manualAmount: 1_000_000n }));

    expect(run.outcome).toBe('aborted');
    expectNothingOnEitherChain();
  });
});

describe('fake endpoint sanity', () => {
  it('a third endpoint disagreeing still vetoes', async () => {
    await setup();
    const c = fakeEvm('https://c.invalid', sickSample('https://c.invalid', { usdcDebt: 1n }));
    h.ctx.clients = [h.a, h.b, c];

    const run = recorded(await tick(h.ctx));

    expect(run.failure_reason).toMatch(/^quorum_disagreement: usdcDebt/);
  });
});
