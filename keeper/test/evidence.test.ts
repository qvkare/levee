import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_EVIDENCE_DIR,
  type RunRecord,
  capsFromTrace,
  capsToTrace,
  parseRun,
  readRuns,
  runId,
  runRecordSchema,
  runsDir,
  sampleFromTrace,
  sampleToTrace,
  writeRun,
} from '../src/evidence.js';
import { sickSample } from './support/fakes.js';

/** The JSON example in spec section 6, plus the two NEAR fields added to it. */
const specExample = {
  run_id: '2026-11-09T10-12-03Z-base-1',
  network: 'mainnet',
  position_id: 1,
  chain_id: 8453,
  borrower: '0x1111111111111111111111111111111111111111',
  rescuer: '0x2222222222222222222222222222222222222222',
  amount: '2500000',
  outcome: 'success',
  failure_reason: null,
  health_factor_before: '1.19',
  health_factor_after: '1.51',
  timestamps_ms: { detected: 0, near_included: 0, signed: 0, broadcast: 0, included: 0 },
  near_tx: 'abc',
  evm_tx: '0xabc',
  evm_block: 0,
  near_contract: 'levee.near',
  near_sender: 'keeper.near',
} as const;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'levee-evidence-'));
});

afterEach(() => rm(dir, { recursive: true, force: true }));

describe('runRecordSchema', () => {
  it('accepts the format in the spec', () => {
    expect(runRecordSchema.parse(specExample)).toEqual(specExample);
  });

  it('accepts a record with no optional trace, as `verify` must', () => {
    expect(runRecordSchema.safeParse(specExample).success).toBe(true);
  });

  it('accepts a failure with the unreached steps left null', () => {
    const failed = {
      ...specExample,
      outcome: 'aborted',
      failure_reason: 'quorum_disagreement',
      amount: '0',
      health_factor_after: null,
      near_tx: null,
      evm_tx: null,
      evm_block: null,
      near_sender: null,
      timestamps_ms: { detected: 5, near_included: null, signed: null, broadcast: null, included: null },
    };
    expect(runRecordSchema.safeParse(failed).success).toBe(true);
  });

  it.each([
    ['an unknown outcome', { outcome: 'partial' }],
    ['an unknown network', { network: 'devnet' }],
    ['a non-decimal amount', { amount: '2.5' }],
  ])('rejects %s', (_name, over) => {
    expect(runRecordSchema.safeParse({ ...specExample, ...over }).success).toBe(false);
  });
});

describe('runId', () => {
  it('matches the form in the spec', () => {
    const date = new Date(Date.UTC(2026, 10, 9, 10, 12, 3, 456));
    expect(runId(date, 'base', 1)).toBe('2026-11-09T10-12-03Z-base-1');
  });
});

describe('writeRun', () => {
  const record = specExample as unknown as RunRecord;

  it('writes readable JSON named for the run', async () => {
    const { path, run } = await writeRun(dir, record);
    expect(path).toBe(join(runsDir(dir), `${specExample.run_id}.json`));
    expect(parseRun(await readFile(path, 'utf8'))).toEqual(run);
  });

  it('never overwrites an earlier run', async () => {
    const first = await writeRun(dir, record);
    const second = await writeRun(dir, { ...record, outcome: 'failed', failure_reason: 'x' });

    expect(second.path).not.toBe(first.path);
    expect(second.run.run_id).toBe(`${specExample.run_id}-r2`);
    expect(parseRun(await readFile(first.path, 'utf8')).outcome).toBe('success');
  });

  it('refuses to write a malformed record', async () => {
    await expect(writeRun(dir, { ...record, amount: 'lots' })).rejects.toThrow();
  });
});

describe('readRuns', () => {
  it('returns nothing for a repo with no runs yet', async () => {
    expect(await readRuns(join(dir, 'missing'))).toEqual({ runs: [], invalid: [] });
  });

  it('reports a damaged file instead of quietly dropping it', async () => {
    await writeRun(dir, specExample as unknown as RunRecord);
    await writeFile(join(runsDir(dir), 'broken.json'), '{ not json');
    await writeFile(join(runsDir(dir), 'notes.txt'), 'ignored');

    const { runs, invalid } = await readRuns(dir);

    expect(runs).toHaveLength(1);
    expect(invalid.map((entry) => entry.file)).toEqual(['broken.json']);
  });
});

describe('trace round trips', () => {
  it('keeps every bigint of a sample exactly', () => {
    const sample = sickSample('a', { healthFactor: 2n ** 256n - 1n });
    expect(sampleFromTrace(sampleToTrace(sample))).toEqual(sample);
  });

  it('keeps the caps exactly', () => {
    const caps = {
      maxPerRescue: 1n,
      remainingToday: 2n,
      rescuerBalance: 3n,
      rescuerAllowance: 4n,
      cooldownRemainingSecs: 5,
      paused: true,
    };
    expect(capsFromTrace(capsToTrace(caps))).toEqual(caps);
  });
});

describe('DEFAULT_EVIDENCE_DIR', () => {
  it('points at the repo root evidence directory', () => {
    expect(DEFAULT_EVIDENCE_DIR.endsWith('/evidence')).toBe(true);
    expect(DEFAULT_EVIDENCE_DIR.includes('/keeper/')).toBe(false);
  });
});
