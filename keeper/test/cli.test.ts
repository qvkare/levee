/** Runs the real CLI as a child process, with no keys and no network. */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/config.js';
import { type RunRecord, writeRun } from '../src/evidence.js';
import { tick } from '../src/rescue.js';
import { harness } from './support/fakes.js';

const run = promisify(execFile);
const keeperDir = resolve(REPO_ROOT, 'keeper');

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** A bare environment: nothing a keeper key or RPC list could leak in from. */
async function cli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      ['--import', 'tsx', 'src/cli.ts', ...args],
      { cwd: keeperDir, env: { PATH: process.env.PATH, ...env } },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

let dir: string;

const recordRun = async (): Promise<RunRecord> => {
  const h = await harness();
  try {
    const result = await tick({ ...h.ctx, evidenceDir: dir });
    if (result.status !== 'recorded') throw new Error('expected a record');
    return result.run;
  } finally {
    await h.cleanup();
  }
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'levee-cli-'));
});

afterEach(() => rm(dir, { recursive: true, force: true }));

describe('usage', () => {
  it('lists every command', async () => {
    const { code, stdout } = await cli(['help']);

    expect(code).toBe(0);
    for (const command of ['status', 'run', 'rescue-once', 'derive-address', 'verify', 'replay']) {
      expect(stdout).toContain(command);
    }
  });

  it('fails on an unknown command', async () => {
    const { code, stderr } = await cli(['explode']);
    expect(code).toBe(1);
    expect(stderr).toContain('unknown command: explode');
  });

  it('fails with no command', async () => {
    expect((await cli([])).code).toBe(1);
  });
});

describe('verify', () => {
  it('works with no keys and no configuration', async () => {
    const recorded = await recordRun();
    await writeFile(
      join(dir, 'claims.json'),
      JSON.stringify({
        claims: [
          { id: 'sim', claim: 'A simulated rescue.', run: recorded.run_id },
          {
            id: 'repay',
            claim: 'Repay leaves collateral alone.',
            test: {
              path: 'evm/test/lib/RepayPath.sol',
              name: 'test_thirdPartyRepay_explicitAmount_collateralDoesNotMove',
            },
          },
        ],
      }),
    );

    const { code, stdout } = await cli(['verify'], { EVIDENCE_DIR: dir });

    expect(stdout).toContain('RECORDED  sim');
    expect(stdout).toContain('RECORDED  repay');
    expect(stdout).toContain('2 claims: 0 PASS, 0 FAIL, 2 RECORDED');
    expect(code).toBe(0);
  });

  it('exits non-zero when a claim fails', async () => {
    await writeFile(
      join(dir, 'claims.json'),
      JSON.stringify({ claims: [{ id: 'gone', claim: 'Unbacked.', run: 'missing-run' }] }),
    );

    const { code, stdout } = await cli(['verify'], { EVIDENCE_DIR: dir });

    expect(code).toBe(1);
    expect(stdout).toContain('FAIL      gone');
  });

  it('explains a missing ledger', async () => {
    const { code, stderr } = await cli(['verify'], { EVIDENCE_DIR: dir });
    expect(code).toBe(1);
    expect(stderr).toContain('claims.json');
  });
});

describe('replay', () => {
  it('replays a run by id', async () => {
    const recorded = await recordRun();

    const { code, stdout } = await cli(['replay', recorded.run_id], { EVIDENCE_DIR: dir });

    expect(stdout).toContain('Replay matches the record.');
    expect(code).toBe(0);
  });

  it('replays a run by file path', async () => {
    const recorded = await recordRun();
    const path = join(dir, 'runs', `${recorded.run_id}.json`);

    const { code } = await cli(['replay', path]);

    expect(code).toBe(0);
  });

  it('exits non-zero for a record that no longer replays', async () => {
    const recorded = await recordRun();
    const altered = await writeRun(dir, { ...recorded, run_id: 'altered', amount: '1' });

    const { code, stdout } = await cli(['replay', altered.path]);

    expect(code).toBe(1);
    expect(stdout).toContain('MISMATCH');
  });

  it('reports a run that is not on file', async () => {
    const { code, stderr } = await cli(['replay', 'no-such-run'], { EVIDENCE_DIR: dir });
    expect(code).toBe(1);
    expect(stderr).toContain('no-such-run');
  });

  it('asks for a run when none is given', async () => {
    const { code, stderr } = await cli(['replay']);
    expect(code).toBe(1);
    expect(stderr).toContain('needs a run');
  });
});

describe('commands that need configuration', () => {
  it('status explains what is missing', async () => {
    const { code, stderr } = await cli(['status']);
    expect(code).toBe(1);
    expect(stderr).toContain('LEVEE_CONTRACT');
  });

  it('run explains what is missing before touching a key', async () => {
    const positions = join(dir, 'positions.json');
    await writeFile(
      positions,
      JSON.stringify({ positions: [{ id: 1, trigger: '1.25', target: '1.6' }], fee_ceilings: {} }),
    );

    const { code, stderr } = await cli(['run'], {
      LEVEE_CONTRACT: 'levee.testnet',
      KEEPER_CONFIG: positions,
    });

    expect(code).toBe(1);
    expect(stderr).toContain('KEEPER_ACCOUNT and KEEPER_PRIVATE_KEY');
  });

  it('rescue-once needs a position', async () => {
    const { code, stderr } = await cli(['rescue-once']);
    expect(code).toBe(1);
    expect(stderr).toContain('--id');
  });

  it('derive-address needs a target', async () => {
    const { code, stderr } = await cli(['derive-address', '--contract', 'levee.testnet']);
    expect(code).toBe(1);
    expect(stderr).toContain('--id or --path');
  });
});
