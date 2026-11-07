import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunRecord } from '../src/evidence.js';
import { formatReplay, replayRun } from '../src/replay.js';
import { tick } from '../src/rescue.js';
import { type Harness, fakeNear, harness, sickSample } from './support/fakes.js';
import { createSimulatedMpc } from './support/simulated-mpc.js';

let h: Harness;

beforeEach(async () => {
  h = await harness();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await h.cleanup();
});

const record = async (): Promise<RunRecord> => {
  const result = await tick(h.ctx);
  if (result.status !== 'recorded') throw new Error(`expected a record, got ${result.status}`);
  return result.run;
};

const mismatched = async (run: RunRecord) =>
  (await replayRun(run)).steps.filter((step) => step.ok === false).map((step) => step.title);

/** A deep copy, so a test can edit a record the way a forger would. */
const clone = (run: RunRecord): RunRecord => JSON.parse(JSON.stringify(run));

describe('replaying a recorded rescue', () => {
  it('reproduces every step of a success', async () => {
    const result = await replayRun(await record());

    expect(result.ok).toBe(true);
    expect(result.steps.map((step) => step.title)).toEqual([
      expect.stringMatching(/^Run /),
      'Quorum',
      'Decision',
      'Fees',
      'NEAR rescue',
      'Signature',
      'Broadcast',
      'Receipt',
      'Timeline',
    ]);
  });

  it('opens no connection', async () => {
    const run = await record();
    const fetchSpy = vi.fn(() => {
      throw new Error('replay must not use the network');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const result = await replayRun(run);

    expect(result.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('labels a simulated run in its first lines', async () => {
    const text = formatReplay(await replayRun(await record()));
    expect(text.split('\n')[1]).toContain('SIMULATED');
  });

  it('prints the steps in order with a verdict', async () => {
    const text = formatReplay(await replayRun(await record()));

    expect(text).toMatch(/^1\. Run /);
    expect(text).toContain('[ok]');
    expect(text).toContain('Replay matches the record.');
  });
});

describe('replaying a refusal', () => {
  it('reproduces a quorum refusal', async () => {
    h.b.sample = sickSample(h.b.url, { healthFactor: 1_300_000_000_000_000_000n });

    const result = await replayRun(await record());

    expect(result.ok).toBe(true);
    expect(result.steps.map((step) => step.title)).toEqual([
      expect.stringMatching(/^Run /),
      'Quorum',
      'Timeline',
    ]);
  });

  it('reproduces a refused signature, recovering the wrong signer again', async () => {
    h.ctx.near = fakeNear(createSimulatedMpc());

    const run = await record();
    const result = await replayRun(run);

    expect(run.failure_reason).toMatch(/^signer_mismatch/);
    expect(result.ok).toBe(true);
    const signature = result.steps.find((step) => step.title === 'Signature');
    expect(signature?.lines.join(' ')).toContain('refused: signer_mismatch');
  });

  it('replays a blocked decision with no NEAR step', async () => {
    h.a.sample = sickSample(h.a.url, { rescuerUsdc: 0n });
    h.b.sample = sickSample(h.b.url, { rescuerUsdc: 0n });

    const result = await replayRun(await record());

    expect(result.ok).toBe(true);
    expect(result.steps.some((step) => step.title === 'NEAR rescue')).toBe(false);
    expect(result.steps.find((step) => step.title === 'Decision')?.lines.join(' ')).toContain(
      'no action: rescuer_empty',
    );
  });
});

describe('replaying an altered record', () => {
  it('catches an edited amount', async () => {
    const run = clone(await record());
    run.amount = '1';
    expect(await mismatched(run)).toEqual(['Signature']);
  });

  it('catches an edited decision', async () => {
    const run = clone(await record());
    if (run.trace?.decision) run.trace.decision.amount = '999';
    expect(await mismatched(run)).toEqual(['Decision']);
  });

  it('catches edited inputs to the decision', async () => {
    const run = clone(await record());
    const sample = run.trace?.quorum?.samples[0];
    const other = run.trace?.quorum?.samples[1];
    if (sample && other) {
      sample.total_debt_base = '1400100000000';
      other.total_debt_base = '1400100000000';
    }
    expect(await mismatched(run)).toEqual(['Decision']);
  });

  it('catches a refusal rewritten as agreement', async () => {
    h.b.sample = sickSample(h.b.url, { healthFactor: 1_300_000_000_000_000_000n });
    const run = clone(await record());
    if (run.trace?.quorum) run.trace.quorum.refused = null;
    expect(await mismatched(run)).toEqual(['Quorum']);
  });

  it('catches a signature from another key', async () => {
    const run = clone(await record());
    const other = createSimulatedMpc().sign(`0x${run.trace?.rescue_result?.unsigned_tx}`, 1);
    if (run.trace) run.trace.rescue_result = other;
    expect(await mismatched(run)).toEqual(['Signature']);
  });

  it('catches an EVM hash that is not the signed transaction', async () => {
    const run = clone(await record());
    run.evm_tx = `0x${'00'.repeat(32)}`;
    expect(await mismatched(run)).toEqual(['Broadcast']);
  });

  it('catches an edited block number', async () => {
    const run = clone(await record());
    run.evm_block = 5;
    expect(await mismatched(run)).toEqual(['Receipt']);
  });

  it('says so in the printed verdict', async () => {
    const run = clone(await record());
    run.amount = '1';
    const text = formatReplay(await replayRun(run));
    expect(text).toContain('[MISMATCH]');
    expect(text).toContain('DOES NOT match');
  });
});

describe('a record without a trace', () => {
  it('shows what it can and claims nothing', async () => {
    const run = clone(await record());
    delete run.trace;

    const result = await replayRun(run);

    expect(result.ok).toBe(true);
    expect(result.steps.map((step) => step.ok)).toEqual([null, null, null]);
    expect(formatReplay(result)).toContain('no trace');
  });
});
