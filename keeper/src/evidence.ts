/**
 * Run records, spec section 6. A record is written for every rescue attempt, and an
 * existing record is never overwritten: failed runs stay in `evidence/`.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Caps, Decision } from './decision.js';
import type { Sample } from './quorum.js';
import { rescueResultSchema } from './signature.js';

/** `network` for a run that never touched a real chain or the real MPC. */
export const SIMULATED = 'simulated';

const decimal = z.string().regex(/^\d+$/);
const hex = z.string().regex(/^0x[0-9a-fA-F]*$/);

const sampleSchema = z.object({
  rpc: z.string(),
  chain_id: z.number(),
  block_number: decimal,
  block_timestamp: decimal,
  health_factor: decimal,
  total_collateral_base: decimal,
  total_debt_base: decimal,
  liquidation_threshold_bps: decimal,
  usdc_price_base: decimal,
  usdc_debt: decimal,
  rescuer_usdc: decimal,
  rescuer_allowance: decimal,
});

type TraceSample = z.infer<typeof sampleSchema>;

const capsSchema = z.object({
  max_per_rescue: decimal,
  remaining_today: decimal,
  rescuer_balance: decimal,
  rescuer_allowance: decimal,
  cooldown_remaining_secs: z.number(),
  paused: z.boolean(),
});

const decisionSchema = z.object({
  action: z.enum(['none', 'repay']),
  reason: z.string().nullable(),
  amount: decimal.nullable(),
  needed: decimal.nullable(),
  limited_by: z.string().nullable(),
  projected_health_factor: decimal.nullable(),
});

/**
 * The inputs and intermediate results of each step, so that `replay` can repeat the
 * run with no keys and no network. An extension to the fields in the spec's example.
 */
const traceSchema = z.object({
  trigger: z.string(),
  target: z.string(),
  manual_amount: decimal.nullable(),
  quorum: z
    .object({
      now_ms: z.number(),
      samples: z.array(sampleSchema),
      failures: z.array(z.object({ rpc: z.string(), error: z.string() })),
      refused: z.object({ reason: z.string(), detail: z.string() }).nullable(),
    })
    .nullable(),
  caps: capsSchema.nullable(),
  decision: decisionSchema.nullable(),
  fees: z
    .object({
      nonce: z.number(),
      max_fee_per_gas: decimal,
      max_priority_fee_per_gas: decimal,
    })
    .nullable(),
  rescue_result: rescueResultSchema.nullable(),
  signed_tx: hex.nullable(),
  broadcast: z
    .array(z.object({ rpc: z.string(), ok: z.boolean(), error: z.string().nullable() }))
    .nullable(),
  receipt: z
    .object({
      success: z.boolean(),
      block_number: decimal,
      gas_used: decimal,
      effective_gas_price: decimal,
    })
    .nullable(),
});

export type Trace = z.infer<typeof traceSchema>;

export const runRecordSchema = z.object({
  run_id: z.string().min(1),
  network: z.enum(['mainnet', 'testnet', SIMULATED]),
  position_id: z.number().int().nonnegative(),
  chain_id: z.number().int(),
  borrower: z.string(),
  rescuer: z.string(),
  amount: decimal,
  outcome: z.enum(['success', 'failed', 'aborted']),
  failure_reason: z.string().nullable(),
  health_factor_before: z.string().nullable(),
  health_factor_after: z.string().nullable(),
  timestamps_ms: z.object({
    detected: z.number().nullable(),
    near_included: z.number().nullable(),
    signed: z.number().nullable(),
    broadcast: z.number().nullable(),
    included: z.number().nullable(),
  }),
  near_tx: z.string().nullable(),
  evm_tx: z.string().nullable(),
  evm_block: z.number().nullable(),
  /** The Levee account, which the rescuer's derivation depends on. */
  near_contract: z.string(),
  /** Signer of `near_tx`. The RPC cannot resolve a hash without it. */
  near_sender: z.string().nullable(),
  trace: traceSchema.optional(),
});

export type RunRecord = z.infer<typeof runRecordSchema>;
export type RunOutcome = RunRecord['outcome'];

/** `2026-11-09T10-12-03Z-base-1`, the form in spec section 6. */
export function runId(date: Date, chainName: string, positionId: number): string {
  const stamp = date.toISOString().slice(0, 19).replaceAll(':', '-');
  return `${stamp}Z-${chainName}-${positionId}`;
}

/** Repo root `evidence/`, wherever the keeper was started from. */
export const DEFAULT_EVIDENCE_DIR = fileURLToPath(new URL('../../evidence', import.meta.url));

export const runsDir = (evidenceDir: string): string => join(evidenceDir, 'runs');

export interface WrittenRun {
  run: RunRecord;
  path: string;
}

/** Creates the file exclusively, so two runs in one second cannot replace each other. */
export async function writeRun(evidenceDir: string, record: RunRecord): Promise<WrittenRun> {
  const parsed = runRecordSchema.parse(record);
  const dir = runsDir(evidenceDir);
  await mkdir(dir, { recursive: true });
  for (let attempt = 1; ; attempt++) {
    const id = attempt === 1 ? parsed.run_id : `${parsed.run_id}-r${attempt}`;
    const run = { ...parsed, run_id: id };
    const path = join(dir, `${id}.json`);
    try {
      await writeFile(path, `${JSON.stringify(run, null, 2)}\n`, { flag: 'wx' });
      return { run, path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

export function parseRun(text: string): RunRecord {
  return runRecordSchema.parse(JSON.parse(text));
}

export async function readRunFile(path: string): Promise<RunRecord> {
  return parseRun(await readFile(path, 'utf8'));
}

export interface InvalidRun {
  file: string;
  error: string;
}

/** Reads every run. A file that does not parse is reported, not skipped. */
export async function readRuns(
  evidenceDir: string,
): Promise<{ runs: RunRecord[]; invalid: InvalidRun[] }> {
  const dir = runsDir(evidenceDir);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { runs: [], invalid: [] };
    throw error;
  }
  const runs: RunRecord[] = [];
  const invalid: InvalidRun[] = [];
  for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
    try {
      runs.push(await readRunFile(join(dir, name)));
    } catch (error) {
      invalid.push({ file: name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { runs, invalid };
}

export function sampleToTrace(sample: Sample): TraceSample {
  return {
    rpc: sample.rpc,
    chain_id: sample.chainId,
    block_number: sample.blockNumber.toString(),
    block_timestamp: sample.blockTimestamp.toString(),
    health_factor: sample.healthFactor.toString(),
    total_collateral_base: sample.totalCollateralBase.toString(),
    total_debt_base: sample.totalDebtBase.toString(),
    liquidation_threshold_bps: sample.liquidationThresholdBps.toString(),
    usdc_price_base: sample.usdcPriceBase.toString(),
    usdc_debt: sample.usdcDebt.toString(),
    rescuer_usdc: sample.rescuerUsdc.toString(),
    rescuer_allowance: sample.rescuerAllowance.toString(),
  };
}

export function sampleFromTrace(sample: TraceSample): Sample {
  return {
    rpc: sample.rpc,
    chainId: sample.chain_id,
    blockNumber: BigInt(sample.block_number),
    blockTimestamp: BigInt(sample.block_timestamp),
    healthFactor: BigInt(sample.health_factor),
    totalCollateralBase: BigInt(sample.total_collateral_base),
    totalDebtBase: BigInt(sample.total_debt_base),
    liquidationThresholdBps: BigInt(sample.liquidation_threshold_bps),
    usdcPriceBase: BigInt(sample.usdc_price_base),
    usdcDebt: BigInt(sample.usdc_debt),
    rescuerUsdc: BigInt(sample.rescuer_usdc),
    rescuerAllowance: BigInt(sample.rescuer_allowance),
  };
}

export function capsToTrace(caps: Caps): NonNullable<Trace['caps']> {
  return {
    max_per_rescue: caps.maxPerRescue.toString(),
    remaining_today: caps.remainingToday.toString(),
    rescuer_balance: caps.rescuerBalance.toString(),
    rescuer_allowance: caps.rescuerAllowance.toString(),
    cooldown_remaining_secs: caps.cooldownRemainingSecs,
    paused: caps.paused,
  };
}

export function capsFromTrace(caps: NonNullable<Trace['caps']>): Caps {
  return {
    maxPerRescue: BigInt(caps.max_per_rescue),
    remainingToday: BigInt(caps.remaining_today),
    rescuerBalance: BigInt(caps.rescuer_balance),
    rescuerAllowance: BigInt(caps.rescuer_allowance),
    cooldownRemainingSecs: caps.cooldown_remaining_secs,
    paused: caps.paused,
  };
}

export function decisionToTrace(decision: Decision): NonNullable<Trace['decision']> {
  if (decision.action === 'none') {
    return {
      action: 'none',
      reason: decision.reason,
      amount: null,
      needed: null,
      limited_by: null,
      projected_health_factor: null,
    };
  }
  return {
    action: 'repay',
    reason: null,
    amount: decision.amount.toString(),
    needed: decision.needed.toString(),
    limited_by: decision.limitedBy,
    projected_health_factor: decision.projectedHealthFactor.toString(),
  };
}
