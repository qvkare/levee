import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Address, Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHAINS } from '../src/chains.js';
import { type RunRecord, runsDir, writeRun } from '../src/evidence.js';
import type { EvmReceipt, EvmTransaction } from '../src/evm.js';
import type { NearTxStatus } from '../src/near.js';
import {
  type Lookups,
  type NearLookup,
  formatReport,
  signingHash,
  verifyEvidence,
  verifyRun,
} from '../src/verify.js';
import { borrower, openPosition } from './support/fakes.js';
import { repayCalldata } from './support/simulated-mpc.js';

const chain = CHAINS[84532] as NonNullable<(typeof CHAINS)[84532]>;
const rescuer: Address = '0x3333333333333333333333333333333333333333';
const stranger: Address = '0x4444444444444444444444444444444444444444';
const evmHash: Hex = `0x${'ab'.repeat(32)}`;
const amount = 2_500_000n;

const onChainTx = (over: Partial<EvmTransaction> = {}): EvmTransaction => ({
  hash: evmHash,
  from: rescuer,
  to: chain.pool,
  input: repayCalldata(chain.usdc, amount, 2n, borrower),
  value: 0n,
  chainId: chain.chainId,
  nonce: 4,
  gas: 300_000n,
  maxFeePerGas: 2_100n,
  maxPriorityFeePerGas: 100n,
  type: 'eip1559',
  blockNumber: 99n,
  ...over,
});

const successRun = (over: Partial<RunRecord> = {}): RunRecord => ({
  run_id: '2026-11-09T10-12-03Z-base-sepolia-1',
  network: 'testnet',
  position_id: 1,
  chain_id: chain.chainId,
  borrower,
  rescuer,
  amount: amount.toString(),
  outcome: 'success',
  failure_reason: null,
  health_factor_before: '1.19',
  health_factor_after: '1.51',
  timestamps_ms: { detected: 1, near_included: 2, signed: 3, broadcast: 4, included: 5 },
  near_tx: 'NearTxHash',
  evm_tx: evmHash,
  evm_block: 99,
  near_contract: 'levee.testnet',
  near_sender: 'keeper.testnet',
  ...over,
});

interface World {
  tx: EvmTransaction | null;
  receipt: EvmReceipt | null;
  nearStatus: NearTxStatus;
  nearError?: Error;
  evmError?: Error;
  derived: Address;
  asOf: 'block' | 'latest';
}

const nearStatusFor = (tx: EvmTransaction): NearTxStatus => ({
  success: true,
  failure: null,
  signerId: 'keeper.testnet',
  receiverId: 'levee.testnet',
  methodName: 'rescue',
  args: { id: 1, amount: amount.toString(), fees: {} },
  blockHash: 'Block',
  returnValue: {
    kind: 'rescue',
    id: 1,
    unsigned_tx: '02',
    tx_hash: signingHash(tx).slice(2),
    big_r: `02${'cd'.repeat(32)}`,
    s: '11'.repeat(32),
    recovery_id: 0,
  },
});

const world = (over: Partial<World> = {}): World => {
  const tx = onChainTx();
  return {
    tx,
    receipt: { success: true, blockNumber: 99n, gasUsed: 1n, effectiveGasPrice: 1n },
    nearStatus: nearStatusFor(tx),
    derived: rescuer,
    asOf: 'block',
    ...over,
  };
};

const lookupsFor = (state: World): Lookups => ({
  chain: () => ({
    async transaction() {
      if (state.evmError) throw state.evmError;
      return state.tx;
    },
    async receipt() {
      if (state.evmError) throw state.evmError;
      return state.receipt;
    },
  }),
  near: (): NearLookup => ({
    async transaction() {
      if (state.nearError) throw state.nearError;
      return state.nearStatus;
    },
    position: async () => ({ position: openPosition(), asOf: state.asOf }),
    rescuerAddress: async () => state.derived,
    chain: async () => null,
  }),
});

const failing = async (run: RunRecord, state: World) => {
  const verdict = await verifyRun(run, lookupsFor(state));
  return { verdict: verdict.verdict, failed: verdict.checks.filter((c) => !c.ok).map((c) => c.name) };
};

describe('verifyRun on a successful run', () => {
  it('passes when every section 6 check holds', async () => {
    const verdict = await verifyRun(successRun(), lookupsFor(world()));

    expect(verdict.checks.filter((check) => !check.ok)).toEqual([]);
    expect(verdict.verdict).toBe('PASS');
    expect(verdict.checks.map((check) => check.name)).toEqual(
      expect.arrayContaining([
        'near_receipt',
        'evm_from',
        'evm_to',
        'selector',
        'asset',
        'on_behalf_of',
        'amount_within_caps',
        'near_signed_evm_tx',
        'evm_receipt',
      ]),
    );
  });

  it('fails when a NEAR receipt failed', async () => {
    const state = world();
    state.nearStatus = { ...state.nearStatus, success: false, failure: 'boom' };
    expect(await failing(successRun(), state)).toEqual({ verdict: 'FAIL', failed: ['near_receipt'] });
  });

  it('fails when the NEAR call was not rescue on this contract', async () => {
    const state = world();
    state.nearStatus = { ...state.nearStatus, methodName: 'withdraw_float', receiverId: 'evil.testnet' };
    expect((await failing(successRun(), state)).failed).toEqual(['near_contract', 'near_method']);
  });

  it('fails when the EVM sender is not the derived rescuer', async () => {
    const tx = onChainTx({ from: stranger });
    const state = world({ tx, nearStatus: nearStatusFor(tx) });
    expect((await failing(successRun(), state)).failed).toEqual(['evm_from']);
  });

  it('fails when the record names a rescuer that is not the derived one', async () => {
    const state = world({ derived: stranger });
    expect((await failing(successRun(), state)).failed).toContain('rescuer_derived');
  });

  it.each<[string, Partial<EvmTransaction>, string[]]>([
    ['another target', { to: stranger }, ['evm_to']],
    ['value attached', { value: 1n }, ['evm_value']],
    ['a transfer selector', { input: '0xa9059cbb' }, ['selector', 'repay_args']],
    [
      'another asset',
      { input: repayCalldata(stranger, amount, 2n, borrower) },
      ['asset'],
    ],
    [
      'another borrower',
      { input: repayCalldata(chain.usdc, amount, 2n, stranger) },
      ['on_behalf_of'],
    ],
    ['the wrong rate mode', { input: repayCalldata(chain.usdc, amount, 1n, borrower) }, ['rate_mode']],
    [
      'an amount other than recorded',
      { input: repayCalldata(chain.usdc, amount + 1n, 2n, borrower) },
      ['amount'],
    ],
    ['another chain', { chainId: 1 }, ['evm_chain']],
  ])('fails on %s', async (_name, change, expected) => {
    const tx = onChainTx(change);
    const state = world({ tx, nearStatus: nearStatusFor(tx) });
    expect((await failing(successRun(), state)).failed).toEqual(expected);
  });

  it('fails when the amount is above the caps', async () => {
    const big = 6_000n * 10n ** 6n;
    const tx = onChainTx({ input: repayCalldata(chain.usdc, big, 2n, borrower) });
    const state = world({ tx });
    state.nearStatus = { ...nearStatusFor(tx), args: { id: 1, amount: big.toString() } };
    const run = successRun({ amount: big.toString() });
    expect((await failing(run, state)).failed).toEqual(['amount_within_caps']);
  });

  it('fails when the EVM transaction is not the one NEAR signed', async () => {
    const signed = onChainTx({ nonce: 4 });
    const landed = onChainTx({ nonce: 5 });
    const state = world({ tx: landed, nearStatus: nearStatusFor(signed) });
    expect((await failing(successRun(), state)).failed).toEqual(['near_signed_evm_tx']);
  });

  it('fails when the transaction reverted', async () => {
    const state = world({
      receipt: { success: false, blockNumber: 99n, gasUsed: 1n, effectiveGasPrice: 1n },
    });
    expect((await failing(successRun(), state)).failed).toEqual(['evm_receipt']);
  });

  it('fails when the block does not match', async () => {
    expect((await failing(successRun({ evm_block: 98 }), world())).failed).toEqual(['evm_block']);
  });

  it('fails when a hash does not resolve', async () => {
    expect(await failing(successRun(), world({ tx: null }))).toEqual({
      verdict: 'FAIL',
      failed: ['evm_tx'],
    });
  });

  it('fails rather than passes when an RPC is unreachable', async () => {
    const evm = await failing(successRun(), world({ evmError: new Error('down') }));
    expect(evm).toEqual({ verdict: 'FAIL', failed: ['evm_tx'] });
    const near = await failing(successRun(), world({ nearError: new Error('down') }));
    expect(near.verdict).toBe('FAIL');
    expect(near.failed).toContain('near_tx');
  });

  it('fails a claimed success with a hash missing from the record', async () => {
    expect((await failing(successRun({ near_tx: null }), world())).failed).toContain('near_tx');
    expect((await failing(successRun({ evm_tx: null }), world())).failed).toContain('evm_tx');
  });

  it('says so when the caps had to come from the latest state', async () => {
    const verdict = await verifyRun(successRun(), lookupsFor(world({ asOf: 'latest' })));
    expect(verdict.verdict).toBe('PASS');
    expect(verdict.checks.find((check) => check.name === 'caps_as_of')?.detail).toContain('latest');
  });
});

describe('verifyRun on a failure whose hash never landed', () => {
  const unresolved = { verdict: 'RECORDED', failed: [] };

  it('records a broadcast that every endpoint rejected', async () => {
    const run = successRun({
      outcome: 'failed',
      failure_reason: 'broadcast_rejected: insufficient funds',
      evm_block: null,
    });
    expect(await failing(run, world({ tx: null, receipt: null }))).toEqual(unresolved);
  });

  it('records a transaction that never got a receipt', async () => {
    const run = successRun({ outcome: 'failed', failure_reason: 'receipt_timeout', evm_block: null });
    expect(await failing(run, world({ tx: null, receipt: null }))).toEqual(unresolved);
  });

  it('records a NEAR transaction that expired unexecuted', async () => {
    const run = successRun({
      outcome: 'failed',
      failure_reason: 'near_timeout',
      evm_tx: null,
      evm_block: null,
    });
    expect(await failing(run, world({ nearError: new Error('unknown transaction') }))).toEqual(
      unresolved,
    );
  });

  it('still fails a claimed success on the same missing hash', async () => {
    expect((await failing(successRun(), world({ tx: null }))).verdict).toBe('FAIL');
    const near = await failing(successRun(), world({ nearError: new Error('unknown') }));
    expect(near.verdict).toBe('FAIL');
  });
});

describe('verifyRun on other records', () => {
  it('never passes a simulated run, and resolves nothing for it', async () => {
    const unreachable = new Proxy({} as Lookups, {
      get() {
        throw new Error('a simulated run must not touch the network');
      },
    });
    const verdict = await verifyRun(successRun({ network: 'simulated' }), unreachable);
    expect(verdict.verdict).toBe('RECORDED');
    expect(verdict.note).toContain('simulated');
  });

  it('records an aborted run that never reached a chain', async () => {
    const verdict = await verifyRun(
      successRun({
        outcome: 'aborted',
        failure_reason: 'quorum_disagreement',
        near_tx: null,
        near_sender: null,
        evm_tx: null,
        evm_block: null,
      }),
      lookupsFor(world()),
    );
    expect(verdict).toMatchObject({ verdict: 'RECORDED', note: 'aborted: quorum_disagreement' });
  });

  it('records a failed run whose transaction checks out', async () => {
    const run = successRun({ outcome: 'failed', failure_reason: 'evm_reverted' });
    const state = world({
      receipt: { success: false, blockNumber: 99n, gasUsed: 1n, effectiveGasPrice: 1n },
    });
    const verdict = await verifyRun(run, lookupsFor(state));
    expect(verdict.verdict).toBe('RECORDED');
  });

  it('fails a failed run whose transaction does not check out', async () => {
    const tx = onChainTx({ from: stranger });
    const run = successRun({ outcome: 'failed', failure_reason: 'evm_reverted' });
    const verdict = await verifyRun(run, lookupsFor(world({ tx, nearStatus: nearStatusFor(tx) })));
    expect(verdict.verdict).toBe('FAIL');
  });

  it('records a refused rescue, which has a NEAR hash and no EVM hash', async () => {
    const run = successRun({
      outcome: 'aborted',
      failure_reason: 'signer_mismatch',
      evm_tx: null,
      evm_block: null,
    });
    const verdict = await verifyRun(run, lookupsFor(world()));
    expect(verdict.verdict).toBe('RECORDED');
  });

  it('fails a record whose chain is not on the network it claims', async () => {
    const verdict = await verifyRun(successRun({ network: 'mainnet' }), lookupsFor(world()));
    expect(verdict.verdict).toBe('FAIL');
    expect(verdict.note).toContain('not a mainnet chain');
  });

  it('fails a record on a chain outside the spec', async () => {
    const verdict = await verifyRun(successRun({ chain_id: 1 }), lookupsFor(world()));
    expect(verdict.verdict).toBe('FAIL');
  });
});

describe('verifyEvidence', () => {
  let root: string;
  let evidenceDir: string;

  const writeClaims = (claims: unknown[]) =>
    writeFile(join(evidenceDir, 'claims.json'), JSON.stringify({ claims }));

  const verify = (state = world()) =>
    verifyEvidence({ evidenceDir, repoRoot: root, lookups: lookupsFor(state) });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'levee-verify-'));
    evidenceDir = join(root, 'evidence');
    await mkdir(evidenceDir, { recursive: true });
    await mkdir(join(root, 'evm'), { recursive: true });
    await writeFile(join(root, 'evm', 'Repay.t.sol'), 'function test_repay() public {}');
  });

  afterEach(() => rm(root, { recursive: true, force: true }));

  it('maps a claim to its run', async () => {
    const { run } = await writeRun(evidenceDir, successRun());
    await writeClaims([{ id: 'c1', claim: 'It rescues.', run: run.run_id }]);

    const report = await verify();

    expect(report.ok).toBe(true);
    expect(report.claims).toMatchObject([{ id: 'c1', verdict: 'PASS' }]);
  });

  it('records a claim backed by a test that exists, without running it', async () => {
    await writeClaims([
      { id: 'c1', claim: 'Repay works.', test: { path: 'evm/Repay.t.sol', name: 'test_repay' } },
    ]);

    const report = await verify();

    expect(report.ok).toBe(true);
    expect(report.claims[0]?.verdict).toBe('RECORDED');
  });

  it('fails a claim whose test has gone', async () => {
    await writeClaims([
      { id: 'a', claim: 'Renamed.', test: { path: 'evm/Repay.t.sol', name: 'test_old' } },
      { id: 'b', claim: 'Deleted.', test: { path: 'evm/Gone.t.sol', name: 'test_repay' } },
    ]);

    const report = await verify();

    expect(report.ok).toBe(false);
    expect(report.claims.map((claim) => claim.verdict)).toEqual(['FAIL', 'FAIL']);
  });

  it('fails a claim whose run is not on file', async () => {
    await writeClaims([{ id: 'c1', claim: 'It rescues.', run: 'missing' }]);
    expect((await verify()).claims[0]?.verdict).toBe('FAIL');
  });

  it('carries a failing run through to its claim', async () => {
    const { run } = await writeRun(evidenceDir, successRun());
    await writeClaims([{ id: 'c1', claim: 'It rescues.', run: run.run_id }]);

    const report = await verify(world({ tx: null }));

    expect(report.ok).toBe(false);
    expect(report.claims[0]?.verdict).toBe('FAIL');
  });

  it('fails on a bad run that no claim mentions, because failures are not hidden', async () => {
    await writeRun(evidenceDir, successRun());
    await writeClaims([]);

    const report = await verify(world({ tx: null }));

    expect(report.ok).toBe(false);
    expect(report.runs[0]?.verdict).toBe('FAIL');
  });

  it('fails on a run file that does not parse', async () => {
    await mkdir(runsDir(evidenceDir), { recursive: true });
    await writeFile(join(runsDir(evidenceDir), 'broken.json'), 'nope');
    await writeClaims([]);

    const report = await verify();

    expect(report.ok).toBe(false);
    expect(report.invalidRuns[0]?.file).toBe('broken.json');
  });

  it('rejects a claim mapped to both or neither', async () => {
    await writeClaims([{ id: 'c1', claim: 'Unbacked.' }]);
    await expect(verify()).rejects.toThrow(/exactly one/);

    const test = { path: 'evm/Repay.t.sol', name: 'test_repay' };
    await writeClaims([{ id: 'c1', claim: 'Doubled.', run: 'x', test }]);
    await expect(verify()).rejects.toThrow(/exactly one/);
  });

  it('rejects a repo with no claims ledger', async () => {
    await expect(verify()).rejects.toThrow();
  });

  it('keeps simulated runs out of PASS in the printed report', async () => {
    const { run } = await writeRun(evidenceDir, successRun({ network: 'simulated' }));
    await writeClaims([{ id: 'c1', claim: 'Simulated.', run: run.run_id }]);

    const text = formatReport(await verify());

    expect(text).toContain('RECORDED  c1');
    expect(text).toContain('0 PASS, 0 FAIL, 1 RECORDED');
  });

  it('prints each failed check under its run', async () => {
    await writeRun(evidenceDir, successRun());
    await writeClaims([]);

    const text = formatReport(await verify(world({ tx: null })));

    expect(text).toContain('FAIL      2026-11-09T10-12-03Z-base-sepolia-1');
    expect(text).toContain('evm_tx: ');
  });
});
