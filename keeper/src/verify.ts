/**
 * `make verify`, spec section 6. Resolves every hash in the evidence against public
 * RPCs and needs no keys. The verdicts mean:
 *
 *   PASS      every check ran and held, on a real network, for a successful run.
 *   FAIL      a check did not hold, or could not be made. A claim only passes on proof.
 *   RECORDED  the evidence is on file but this tool does not prove it: a test it did
 *             not run, a simulated run, or a failed run kept for the record.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Address, type Hex, keccak256, serializeTransaction } from 'viem';
import { z } from 'zod';
import { type Network, chainInfo } from './chains.js';
import { type InvalidRun, type RunRecord, SIMULATED, modeOf, readRuns } from './evidence.js';
import type { EvmReceipt, EvmTransaction } from './evm.js';
import { type ChainConfig, type NearTxStatus, type Position, RESCUE_METHODS } from './near.js';
import {
  REPAY_SELECTOR,
  VARIABLE_RATE_MODE,
  decodeRepay,
  rescueResultSchema,
} from './signature.js';
import { UNWIND_SELECTOR, decodeUnwind, unwoundEvents } from './unwind.js';

export type Verdict = 'PASS' | 'FAIL' | 'RECORDED';

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface RunVerdict {
  runId: string;
  verdict: Verdict;
  note: string;
  checks: Check[];
}

export interface ClaimVerdict {
  id: string;
  claim: string;
  verdict: Verdict;
  note: string;
}

export interface VerifyReport {
  claims: ClaimVerdict[];
  runs: RunVerdict[];
  invalidRuns: InvalidRun[];
  ok: boolean;
}

export interface ChainLookup {
  transaction(hash: Hex): Promise<EvmTransaction | null>;
  receipt(hash: Hex): Promise<EvmReceipt | null>;
}

export interface NearLookup {
  transaction(nearTx: string, sender: string): Promise<NearTxStatus>;
  /** The position at `blockHash` if an endpoint still has it, otherwise the latest. */
  position(
    contract: string,
    id: number,
    blockHash: string,
  ): Promise<{ position: Position; asOf: 'block' | 'latest' }>;
  rescuerAddress(contract: string, id: number): Promise<Address>;
  /** The contract's `get_chain`, which names the chain's `LeveeUnwind`. */
  chain(contract: string, chainId: number): Promise<ChainConfig | null>;
}

export interface Lookups {
  chain(chainId: number): ChainLookup;
  near(network: Network): NearLookup;
}

const claimSchema = z
  .object({
    id: z.string().min(1),
    claim: z.string().min(1),
    test: z.object({ path: z.string(), name: z.string() }).optional(),
    run: z.string().optional(),
  })
  .refine((claim) => (claim.test === undefined) !== (claim.run === undefined), {
    message: 'a claim maps to exactly one of test or run',
  });

const claimsFileSchema = z.object({ claims: z.array(claimSchema) });

type Claim = z.infer<typeof claimSchema>;

const sameAddress = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The hash the MPC signed for this transaction, recomputed from what is on chain. */
export function signingHash(tx: EvmTransaction): Hex {
  return keccak256(
    serializeTransaction({
      type: 'eip1559',
      chainId: tx.chainId,
      nonce: tx.nonce,
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      gas: tx.gas,
      to: tx.to,
      value: tx.value,
      data: tx.input,
      accessList: [],
    }),
  );
}

const normaliseHash = (value: string): string =>
  (value.startsWith('0x') ? value : `0x${value}`).toLowerCase();

/**
 * A failed run can hold a hash that never landed: a rejected broadcast, a receipt
 * timeout, a NEAR transaction that expired. That agrees with the record, and failed
 * runs stay in the evidence, so it must not turn `verify` red for good. A hash found
 * on chain is still checked in full.
 */
const neverLandingIsConsistent = (run: RunRecord): boolean => run.outcome !== 'success';

class Checks {
  readonly list: Check[] = [];

  add(name: string, ok: boolean, detail: string): void {
    this.list.push({ name, ok, detail });
  }

  equal(name: string, actual: unknown, expected: unknown): void {
    this.add(name, actual === expected, `${actual}, expected ${expected}`);
  }

  address(name: string, actual: string | null | undefined, expected: string): void {
    this.add(name, sameAddress(actual, expected), `${actual}, expected ${expected}`);
  }

  get passed(): boolean {
    return this.list.every((check) => check.ok);
  }
}

interface NearFacts {
  status: NearTxStatus;
  position: Position | null;
}

async function checkNear(
  checks: Checks,
  run: RunRecord,
  lookup: NearLookup,
): Promise<NearFacts | null> {
  if (!run.near_tx || !run.near_sender) {
    checks.add('near_tx', false, 'the record has no NEAR transaction and sender to resolve');
    return null;
  }
  let status: NearTxStatus;
  try {
    status = await lookup.transaction(run.near_tx, run.near_sender);
  } catch (error) {
    checks.add('near_tx', neverLandingIsConsistent(run), describeError(error));
    return null;
  }

  if (run.outcome === 'success') {
    checks.add('near_receipt', status.success, status.failure ?? 'every receipt succeeded');
  }
  checks.equal('near_contract', status.receiverId, run.near_contract);
  checks.equal('near_method', status.methodName, RESCUE_METHODS[modeOf(run)]);

  const args = status.args as { id?: unknown; amount?: unknown; max_sold?: unknown } | null;
  checks.equal('near_position', args?.id, run.position_id);
  checks.equal('near_amount', args?.amount, run.amount);
  if (modeOf(run) === 'collateral') {
    checks.equal('near_max_sold', args?.max_sold, run.max_sold ?? null);
  }

  let position: Position | null = null;
  try {
    const read = await lookup.position(run.near_contract, run.position_id, status.blockHash);
    position = read.position;
    if (read.asOf === 'latest') {
      checks.add('caps_as_of', true, 'block state is gone, using the latest caps');
    }
  } catch (error) {
    checks.add('position', false, describeError(error));
  }
  return { status, position };
}

function checkRepayCall(checks: Checks, run: RunRecord, tx: EvmTransaction, position: Position | null) {
  const chain = chainInfo(run.chain_id);
  checks.equal('evm_chain', tx.chainId, run.chain_id);
  checks.address('evm_to', tx.to, chain.pool);
  checks.equal('evm_value', tx.value, 0n);
  checks.equal('selector', tx.input.slice(0, 10).toLowerCase(), REPAY_SELECTOR);

  const repay = decodeRepay(tx.input);
  if (!repay) {
    checks.add('repay_args', false, 'calldata does not decode as repay');
    return;
  }
  checks.address('asset', repay.asset, chain.usdc);
  checks.address('on_behalf_of', repay.onBehalfOf, run.borrower);
  checks.equal('rate_mode', repay.rateMode, VARIABLE_RATE_MODE);
  checks.equal('amount', repay.amount.toString(), run.amount);

  if (!position) {
    checks.add('amount_within_caps', false, 'no position to read the caps from');
    return;
  }
  checks.address('borrower_registered', position.borrower, run.borrower);
  const withinCaps = repay.amount <= position.max_per_rescue && repay.amount <= position.max_per_day;
  checks.add(
    'amount_within_caps',
    withinCaps,
    `${repay.amount} against max_per_rescue ${position.max_per_rescue}, max_per_day ${position.max_per_day}`,
  );
}

/** Collateral mode: an `unwind` on the helper with the position's own terms. */
function checkUnwindCall(
  checks: Checks,
  run: RunRecord,
  tx: EvmTransaction,
  position: Position | null,
  helper: Address | null,
) {
  checks.equal('evm_chain', tx.chainId, run.chain_id);
  if (helper) checks.address('evm_to', tx.to, helper);
  else checks.add('evm_to', false, 'the contract names no LeveeUnwind helper for this chain');
  checks.equal('evm_value', tx.value, 0n);
  checks.equal('selector', tx.input.slice(0, 10).toLowerCase(), UNWIND_SELECTOR);

  const unwind = decodeUnwind(tx.input);
  if (!unwind) {
    checks.add('unwind_args', false, 'calldata does not decode as unwind');
    return;
  }
  checks.address('borrower', unwind.borrower, run.borrower);
  checks.address('collateral', unwind.collateral, run.collateral ?? '');
  checks.equal('amount', unwind.amount.toString(), run.amount);
  // The keeper's cap, quoted before the NEAR call. The helper also held the sale to the
  // borrower's own slippage bound, which no record can loosen.
  checks.equal('max_sold', unwind.maxSold.toString(), run.max_sold ?? null);

  if (!position) {
    checks.add('amount_within_caps', false, 'no position to read the caps from');
    return;
  }
  checks.address('borrower_registered', position.borrower, run.borrower);
  if (position.collateral) {
    checks.address('collateral_registered', unwind.collateral, position.collateral.asset);
    checks.equal('pool_fee', unwind.poolFee, BigInt(position.collateral.pool_fee));
  } else {
    checks.add('collateral_registered', false, 'the position has no collateral config');
  }
  const withinCaps = unwind.amount <= position.max_per_rescue && unwind.amount <= position.max_per_day;
  checks.add(
    'amount_within_caps',
    withinCaps,
    `${unwind.amount} against max_per_rescue ${position.max_per_rescue}, max_per_day ${position.max_per_day}`,
  );
}

/** The helper's own account of a successful unwind has to agree with the record. */
function checkUnwound(
  checks: Checks,
  run: RunRecord,
  receipt: EvmReceipt | null,
  helper: Address | null,
  rescuer: Address | null,
) {
  if (!helper) return;
  const events = unwoundEvents(receipt?.logs ?? [], helper);
  const [event] = events;
  if (events.length !== 1 || !event) {
    checks.add('unwound_event', false, `${events.length} Unwound events from ${helper}, expected 1`);
    return;
  }
  checks.add('unwound_event', true, `one Unwound event from ${helper}`);
  checks.address('unwound_borrower', event.borrower, run.borrower);
  checks.address('unwound_collateral', event.collateral, run.collateral ?? '');
  if (rescuer) checks.address('unwound_rescuer', event.rescuer, rescuer);
  checks.add(
    'unwound_repaid',
    event.repaid > 0n && event.repaid <= BigInt(run.amount),
    `${event.repaid}, at most ${run.amount}`,
  );
  checks.equal('unwound_sold', event.sold.toString(), run.sold ?? null);
  checks.add(
    'unwound_within_max_sold',
    run.max_sold !== null && run.max_sold !== undefined && event.sold <= BigInt(run.max_sold),
    `${event.sold}, at most ${run.max_sold}`,
  );
  if (run.swap) {
    checks.equal('swap_repaid', event.repaid.toString(), run.swap.repaid);
    checks.equal('swap_sold', event.sold.toString(), run.swap.sold);
  }
}

async function checkEvm(
  checks: Checks,
  run: RunRecord,
  lookup: ChainLookup,
  near: NearFacts | null,
  rescuer: Address | null,
  helper: Address | null,
): Promise<void> {
  if (!run.evm_tx) {
    checks.add('evm_tx', false, 'the record has no EVM transaction to resolve');
    return;
  }
  let tx: EvmTransaction | null;
  let receipt: EvmReceipt | null;
  try {
    [tx, receipt] = await Promise.all([
      lookup.transaction(run.evm_tx as Hex),
      lookup.receipt(run.evm_tx as Hex),
    ]);
  } catch (error) {
    checks.add('evm_tx', neverLandingIsConsistent(run), describeError(error));
    return;
  }
  if (!tx) {
    checks.add('evm_tx', neverLandingIsConsistent(run), `${run.evm_tx} does not resolve`);
    return;
  }

  if (rescuer) checks.address('evm_from', tx.from, rescuer);
  const collateral = modeOf(run) === 'collateral';
  if (collateral) checkUnwindCall(checks, run, tx, near?.position ?? null, helper);
  else checkRepayCall(checks, run, tx, near?.position ?? null);

  // Ties the two chains together. Without it a successful NEAR receipt and a valid
  // repay could be unrelated transactions paired in a dishonest record.
  const result = rescueResultSchema.safeParse(near?.status.returnValue);
  if (result.success) {
    checks.equal('near_signed_evm_tx', signingHash(tx), normaliseHash(result.data.tx_hash));
    checks.equal('near_kind', result.data.kind, collateral ? 'unwind' : 'rescue');
  } else {
    checks.add('near_signed_evm_tx', false, 'the NEAR transaction returned no rescue result');
  }

  if (run.outcome === 'success') {
    if (collateral) checkUnwound(checks, run, receipt, helper, rescuer);
    checks.equal('evm_receipt', receipt?.success, true);
    if (run.evm_block !== null) {
      checks.equal('evm_block', receipt?.blockNumber, BigInt(run.evm_block));
    } else {
      checks.add('evm_block', false, 'a successful run must name its block');
    }
  }
}

/** Runs the section 6 checks for one record. */
export async function verifyRun(run: RunRecord, lookups: Lookups): Promise<RunVerdict> {
  const base = { runId: run.run_id };
  if (run.network === SIMULATED) {
    return {
      ...base,
      verdict: 'RECORDED',
      note: 'simulated run, no real chain or MPC was involved',
      checks: [],
    };
  }

  const chainMatchesNetwork = safeChainNetwork(run.chain_id);
  if (chainMatchesNetwork !== run.network) {
    return {
      ...base,
      verdict: 'FAIL',
      note: `chain ${run.chain_id} is not a ${run.network} chain from spec section 3`,
      checks: [],
    };
  }

  const isSuccess = run.outcome === 'success';
  const summary = isSuccess ? 'success' : `${run.outcome}: ${run.failure_reason}`;
  if (!isSuccess && !run.near_tx && !run.evm_tx) {
    return { ...base, verdict: 'RECORDED', note: summary, checks: [] };
  }

  const checks = new Checks();
  const near = lookups.near(run.network);
  const facts = isSuccess || run.near_tx ? await checkNear(checks, run, near) : null;

  let rescuer: Address | null = null;
  try {
    rescuer = await near.rescuerAddress(run.near_contract, run.position_id);
    checks.address('rescuer_derived', run.rescuer, rescuer);
  } catch (error) {
    checks.add('rescuer_derived', false, describeError(error));
  }

  let helper: Address | null = null;
  if (modeOf(run) === 'collateral' && (isSuccess || run.evm_tx)) {
    try {
      const config = await near.chain(run.near_contract, run.chain_id);
      helper = config?.unwind ? (config.unwind as Address) : null;
    } catch (error) {
      checks.add('helper', false, describeError(error));
    }
  }

  if (isSuccess || run.evm_tx) {
    await checkEvm(checks, run, lookups.chain(run.chain_id), facts, rescuer, helper);
  }

  if (!checks.passed) return { ...base, verdict: 'FAIL', note: summary, checks: checks.list };
  return { ...base, verdict: isSuccess ? 'PASS' : 'RECORDED', note: summary, checks: checks.list };
}

function safeChainNetwork(chainId: number): Network | null {
  try {
    return chainInfo(chainId).network;
  } catch {
    return null;
  }
}

async function verifyTestClaim(
  claim: Claim & { test: NonNullable<Claim['test']> },
  repoRoot: string,
): Promise<ClaimVerdict> {
  const base = { id: claim.id, claim: claim.claim };
  const { path, name } = claim.test;
  let source: string;
  try {
    source = await readFile(join(repoRoot, path), 'utf8');
  } catch {
    return { ...base, verdict: 'FAIL', note: `test file ${path} is missing` };
  }
  if (!source.includes(name)) {
    return { ...base, verdict: 'FAIL', note: `${path} has no test named ${name}` };
  }
  return { ...base, verdict: 'RECORDED', note: `test exists, not run here: ${path} ${name}` };
}

function verifyRunClaim(claim: Claim, runs: Map<string, RunVerdict>): ClaimVerdict {
  const base = { id: claim.id, claim: claim.claim };
  const verdict = claim.run ? runs.get(claim.run) : undefined;
  if (!verdict) return { ...base, verdict: 'FAIL', note: `run ${claim.run} is not on file` };
  return { ...base, verdict: verdict.verdict, note: `run ${verdict.runId}: ${verdict.note}` };
}

async function readClaims(evidenceDir: string): Promise<Claim[]> {
  const text = await readFile(join(evidenceDir, 'claims.json'), 'utf8');
  return claimsFileSchema.parse(JSON.parse(text)).claims;
}

/** Verifies every run and every claim. Works with no keys. */
export async function verifyEvidence(options: {
  evidenceDir: string;
  repoRoot: string;
  lookups: Lookups;
}): Promise<VerifyReport> {
  const { evidenceDir, repoRoot, lookups } = options;
  const { runs, invalid } = await readRuns(evidenceDir);

  const runVerdicts = await Promise.all(runs.map((run) => verifyRun(run, lookups)));
  const byId = new Map(runVerdicts.map((verdict) => [verdict.runId, verdict]));

  const claims = await readClaims(evidenceDir);
  const claimVerdicts = await Promise.all(
    claims.map((claim) =>
      claim.test
        ? verifyTestClaim({ ...claim, test: claim.test }, repoRoot)
        : verifyRunClaim(claim, byId),
    ),
  );

  return {
    claims: claimVerdicts,
    runs: runVerdicts,
    invalidRuns: invalid,
    ok:
      invalid.length === 0 &&
      claimVerdicts.every((claim) => claim.verdict !== 'FAIL') &&
      runVerdicts.every((run) => run.verdict !== 'FAIL'),
  };
}

const pad = (verdict: Verdict): string => verdict.padEnd(8);

/** The text `verify` prints. */
export function formatReport(report: VerifyReport): string {
  const lines: string[] = ['Claims'];
  for (const claim of report.claims) {
    lines.push(`${pad(claim.verdict)}  ${claim.id}`);
    lines.push(`          ${claim.claim}`);
    lines.push(`          ${claim.note}`);
  }
  if (report.claims.length === 0) lines.push('(none)');

  lines.push('', 'Runs');
  for (const run of report.runs) {
    lines.push(`${pad(run.verdict)}  ${run.runId}  ${run.note}`);
    for (const check of run.checks) {
      if (!check.ok) lines.push(`          ${check.name}: ${check.detail}`);
    }
  }
  for (const invalid of report.invalidRuns) {
    lines.push(`${pad('FAIL')}  ${invalid.file}  does not parse: ${invalid.error}`);
  }
  if (report.runs.length + report.invalidRuns.length === 0) lines.push('(none)');

  const count = (verdict: Verdict) =>
    report.claims.filter((claim) => claim.verdict === verdict).length;
  lines.push(
    '',
    `${report.claims.length} claims: ${count('PASS')} PASS, ${count('FAIL')} FAIL, ${count('RECORDED')} RECORDED`,
  );
  return lines.join('\n');
}
