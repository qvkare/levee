import { afterEach, describe, expect, it } from 'vitest';
import { ABORT_RECORD_WINDOW_MS, createAbortThrottle, watchPosition } from '../src/loop.js';
import { type Harness, harness, healthySample, sickSample } from './support/fakes.js';

describe('createAbortThrottle', () => {
  it('allows the first of a reason and holds repeats for the window', () => {
    let clock = 0;
    const allow = createAbortThrottle(() => clock, 1_000);

    expect(allow('quorum_stale')).toBe(true);
    clock = 999;
    expect(allow('quorum_stale')).toBe(false);
    clock = 1_000;
    expect(allow('quorum_stale')).toBe(true);
  });

  it('tracks each reason on its own, so a new failure is not hidden', () => {
    const allow = createAbortThrottle(() => 0, 1_000);

    expect(allow('quorum_stale')).toBe(true);
    expect(allow('rescuer_empty')).toBe(true);
    expect(allow('quorum_stale')).toBe(false);
  });
});

describe('watchPosition', () => {
  let h: Harness;

  afterEach(() => h?.cleanup());

  it('repeats until told to stop', async () => {
    h = await harness();
    h.a.sample = healthySample(h.a.url);
    h.b.sample = healthySample(h.b.url);
    const lines: string[] = [];
    const controller = new AbortController();
    h.ctx.log = (line) => {
      lines.push(line);
      if (lines.length === 3) controller.abort();
    };

    await watchPosition(h.ctx, controller.signal, 1);

    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('position 1: healthy at 1.9');
  });

  it('does not start a pass after the signal has aborted', async () => {
    h = await harness();
    const controller = new AbortController();
    controller.abort();

    await watchPosition(h.ctx, controller.signal, 1);

    expect(h.near.requests).toEqual([]);
  });

  it('stops promptly in the middle of its wait', async () => {
    h = await harness();
    h.a.sample = healthySample(h.a.url);
    h.b.sample = healthySample(h.b.url);
    const controller = new AbortController();
    h.ctx.log = () => setTimeout(() => controller.abort(), 0);

    const started = Date.now();
    await watchPosition(h.ctx, controller.signal, 60_000);

    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('never overlaps passes, so a rescue in flight cannot fire twice', async () => {
    h = await harness();
    let active = 0;
    let highest = 0;
    let passes = 0;
    const controller = new AbortController();
    const read = h.a.readSample;
    h.a.readSample = async (query) => {
      active += 1;
      highest = Math.max(highest, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      passes += 1;
      if (passes === 4) controller.abort();
      return read(query);
    };
    h.a.sample = healthySample(h.a.url);
    h.b.sample = healthySample(h.b.url);

    await watchPosition(h.ctx, controller.signal, 0);

    expect(passes).toBe(4);
    expect(highest).toBe(1);
  });

  it('records a repeating refusal once per window', async () => {
    h = await harness();
    h.b.sample = sickSample(h.b.url, { healthFactor: 1_300_000_000_000_000_000n });
    let lines = 0;
    const controller = new AbortController();
    h.ctx.log = () => {
      lines += 1;
      if (lines === 5) controller.abort();
    };

    await watchPosition(h.ctx, controller.signal, 1);

    expect(await h.runFiles()).toHaveLength(1);
  });

  it('records the same refusal again once the window has passed', async () => {
    h = await harness();
    h.b.sample = sickSample(h.b.url, { healthFactor: 1_300_000_000_000_000_000n });
    let clock = 1_800_000_000_000;
    let lines = 0;
    const controller = new AbortController();
    h.ctx.now = () => clock;
    h.ctx.log = () => {
      lines += 1;
      // Two lines per record: the write, then the outcome.
      clock += ABORT_RECORD_WINDOW_MS / 2;
      if (lines === 6) controller.abort();
    };
    const blockTimestamp = () => BigInt(Math.floor(clock / 1000) - 1);
    const readA = h.a.readSample;
    const readB = h.b.readSample;
    h.a.readSample = async (query) => ({ ...(await readA(query)), blockTimestamp: blockTimestamp() });
    h.b.readSample = async (query) => ({ ...(await readB(query)), blockTimestamp: blockTimestamp() });

    await watchPosition(h.ctx, controller.signal, 1);

    expect((await h.runFiles()).length).toBeGreaterThan(1);
  });

  it('keeps watching after a pass fails to write its record', async () => {
    h = await harness();
    h.b.sample = sickSample(h.b.url, { healthFactor: 1_300_000_000_000_000_000n });
    // A file where the directory should be makes every write fail.
    h.ctx.evidenceDir = '/dev/null/not-a-directory';
    const lines: string[] = [];
    const controller = new AbortController();
    h.ctx.log = (line) => {
      lines.push(line);
      if (lines.length === 2) controller.abort();
    };

    await watchPosition(h.ctx, controller.signal, 1);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('pass failed');
  });
});
