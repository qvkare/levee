/**
 * Run records, spec section 6. A record is written for every rescue attempt, and an
 * existing record is never overwritten: failed runs stay in `evidence/`.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Address } from 'viem';
import type { Caps, Decision } from './decision.js';
import type { CollateralSample, Sample } from './quorum.js';
import { rescueResultSchema } from './signature.js';
import type { QuoteAnswer, SwapPrice } from './unwind.js';

/** `network` for a run that never touched a real chain or the real MPC. */
export const SIMULATED = 'simulated';

const decimal = z.string().regex(/^\d+$/);
const signedDecimal = z.string().regex(/^-?\d+$/);
const hex = z.string().regex(/^0x[0-9a-fA-F]*$/);

/** Collateral mode. Absent from reserve samples, and from every record before v0.2. */
const collateralSampleSchema = z.object({
  price_base: decimal,
  decimals: decimal,
  liquidation_threshold_bps: decimal,
  a_token_balance: decimal,
  a_token_allowance: decimal,
  authorized_rescuer: z.string(),
  max_slippage_bps: decimal,
  trigger_hf: decimal,
  target_hf: decimal,
  /** Added with the audit fixes. A sample without them predates `authorize` naming them. */
  authorized_collateral: z.string().optional(),
  authorized_pool_fee: decimal.optional(),
  /** Another enabled collateral at LTV 0, which blocks every unwind. */
  ltv_zero_collateral: z.string().nullable().optional(),
});

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
  collateral: collateralSampleSchema.optional(),
});

type TraceSample = z.infer<typeof sampleSchema>;

const logSchema = z.object({ address: z.string(), topics: z.array(hex), data: hex });

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
  /** Collateral mode: what the contract signs for. The helper comes from `get_chain`. */
  collateral: z
    .object({ asset: z.string(), helper: z.string(), pool_fee: decimal })
    .nullable()
    .optional(),
  /** Collateral mode: the helper's `Unwound` log and the oracle at its block. */
  unwound: z
    .object({
      log: logSchema,
      decimals: decimal,
      /** Null if no endpoint could read the oracle at that block. */
      collateral_price_base: decimal.nullable(),
      usdc_price_base: decimal.nullable(),
    })
    .nullable()
    .optional(),
  /** A revert, replayed with `eth_call` at its block to read the reason. */
  revert: z.object({ data: hex.nullable(), error: z.string() }).nullable().optional(),
  /**
   * Collateral mode: the QuoterV2 answers `max_sold` was set from, just before the NEAR
   * call, and the helper's oracle bound for the same amount. `replay` repeats the choice.
   */
  quote: z
    .object({
      quoter: z.string(),
      amount: decimal,
      pool_fee: decimal,
      tolerance_bps: decimal,
      oracle_max_in: decimal,
      answers: z.array(
        z.object({ rpc: z.string(), amount_in: decimal.nullable(), error: z.string().nullable() }),
      ),
      /** The quote used: the highest of those that agreed. */
      amount_in: decimal.nullable(),
      max_sold: decimal.nullable(),
    })
    .nullable()
    .optional(),
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
  /** Spec section 9. A record without it is from before v0.2, and is reserve mode. */
  mode: z.enum(['reserve', 'collateral']).optional(),
  /** Collateral mode: the asset the helper may sell. */
  collateral: z.string().nullable().optional(),
  /** Collateral mode: the cap on the collateral sold that the keeper sent, from a quote. */
  max_sold: decimal.nullable().optional(),
  /** Collateral mode: collateral base units sold, from the helper's `Unwound` event. */
  sold: decimal.nullable().optional(),
  /** Collateral mode: what the swap paid against Aave's oracle at its block. */
  swap: z
    .object({
      repaid: decimal,
      sold: decimal,
      collateral_price_base: decimal,
      usdc_price_base: decimal,
      /** Base currency per whole collateral token, after the pool fee. */
      effective_price_base: decimal,
      /** How far below the oracle the collateral sold. Negative is above it. */
      discount_bps: signedDecimal,
    })
    .nullable()
    .optional(),
  trace: traceSchema.optional(),
});

export type RunRecord = z.infer<typeof runRecordSchema>;
export type RunOutcome = RunRecord['outcome'];
export type RunMode = NonNullable<RunRecord['mode']>;

/** A record with no `mode` predates collateral mode, so it is reserve. */
export const modeOf = (run: Pick<RunRecord, 'mode'>): RunMode => run.mode ?? 'reserve';

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

function collateralToTrace(sample: CollateralSample): z.infer<typeof collateralSampleSchema> {
  return {
    price_base: sample.priceBase.toString(),
    decimals: sample.decimals.toString(),
    liquidation_threshold_bps: sample.liquidationThresholdBps.toString(),
    a_token_balance: sample.aTokenBalance.toString(),
    a_token_allowance: sample.aTokenAllowance.toString(),
    authorized_rescuer: sample.authorizedRescuer,
    max_slippage_bps: sample.maxSlippageBps.toString(),
    trigger_hf: sample.triggerHf.toString(),
    target_hf: sample.targetHf.toString(),
    authorized_collateral: sample.authorizedCollateral,
    authorized_pool_fee: sample.authorizedPoolFee.toString(),
    ltv_zero_collateral: sample.ltvZeroCollateral,
  };
}

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

function collateralFromTrace(sample: z.infer<typeof collateralSampleSchema>): CollateralSample {
  return {
    priceBase: BigInt(sample.price_base),
    decimals: BigInt(sample.decimals),
    liquidationThresholdBps: BigInt(sample.liquidation_threshold_bps),
    aTokenBalance: BigInt(sample.a_token_balance),
    aTokenAllowance: BigInt(sample.a_token_allowance),
    authorizedRescuer: sample.authorized_rescuer as Address,
    maxSlippageBps: BigInt(sample.max_slippage_bps),
    triggerHf: BigInt(sample.trigger_hf),
    targetHf: BigInt(sample.target_hf),
    authorizedCollateral: (sample.authorized_collateral ?? ZERO_ADDRESS) as Address,
    authorizedPoolFee: BigInt(sample.authorized_pool_fee ?? '0'),
    ltvZeroCollateral: (sample.ltv_zero_collateral ?? null) as Address | null,
  };
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
    ...(sample.collateral ? { collateral: collateralToTrace(sample.collateral) } : {}),
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
    ...(sample.collateral ? { collateral: collateralFromTrace(sample.collateral) } : {}),
  };
}

export function swapToRecord(swap: SwapPrice): NonNullable<RunRecord['swap']> {
  return {
    repaid: swap.repaid.toString(),
    sold: swap.sold.toString(),
    collateral_price_base: swap.collateralPriceBase.toString(),
    usdc_price_base: swap.usdcPriceBase.toString(),
    effective_price_base: swap.effectivePriceBase.toString(),
    discount_bps: swap.discountBps.toString(),
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

export function quoteAnswersToTrace(answers: readonly QuoteAnswer[]) {
  return answers.map((answer) => ({
    rpc: answer.rpc,
    amount_in: answer.amountIn === null ? null : answer.amountIn.toString(),
    error: answer.error,
  }));
}

export function quoteAnswersFromTrace(
  answers: NonNullable<Trace['quote']>['answers'],
): QuoteAnswer[] {
  return answers.map((answer) => ({
    rpc: answer.rpc,
    amountIn: answer.amount_in === null ? null : BigInt(answer.amount_in),
    error: answer.error,
  }));
}
