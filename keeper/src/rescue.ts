/**
 * One pass of the keeper loop for one position, spec section 5. Every attempt that
 * gets as far as wanting to act ends in a run record, including the ones that fail.
 */
import type { Address, Hex } from 'viem';
import { broadcastToAll, waitForReceipt } from './broadcast.js';
import type { ChainInfo } from './chains.js';
import {
  type Caps,
  type Decision,
  type DecisionInput,
  cooldownRemainingSecs,
  decide,
  decideManual,
  formatWad,
  remainingToday,
} from './decision.js';
import {
  type RunOutcome,
  type RunRecord,
  type Trace,
  type WrittenRun,
  capsToTrace,
  decisionToTrace,
  runId,
  sampleToTrace,
  writeRun,
} from './evidence.js';
import type { EvmClient } from './evm.js';
import { type FeeCeilings, chooseFees, chooseNonce } from './fees.js';
import { NearRescueError, type NearRescuer, type NearViews, type Position } from './near.js';
import { DEFAULT_QUORUM, type QuorumResult, type Sample, readQuorum } from './quorum.js';
import {
  type AssembledTransaction,
  type RepayIntent,
  SignatureRefused,
  assembleSignedTransaction,
  assertMatchesIntent,
} from './signature.js';

export interface PositionTarget {
  id: number;
  /** Decimal strings as configured, kept for the record. */
  trigger: string;
  target: string;
  triggerWad: bigint;
  targetWad: bigint;
}

export interface RescueContext {
  network: RunRecord['network'];
  chain: ChainInfo;
  position: PositionTarget;
  borrower: Address;
  /** The derived rescuer. Nothing signed by any other key is broadcast. */
  rescuer: Address;
  nearContract: string;
  clients: EvmClient[];
  near: NearRescuer;
  views: Pick<NearViews, 'getPosition'>;
  ceilings: FeeCeilings;
  evidenceDir: string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
  receiptTimeoutMs?: number;
  receiptPollMs?: number;
  /** Returns false to keep a repeating refusal out of the evidence. */
  allowAbortRecord?: (reason: string) => boolean;
}

export interface TickOptions {
  /** `rescue-once --amount`: fire now for this amount, still within every cap. */
  manualAmount?: bigint;
}

export type TickResult =
  | { status: 'idle'; reason: string; healthFactor: bigint | null }
  | { status: 'quiet'; reason: string }
  | ({ status: 'recorded' } & WrittenRun);

const DEFAULT_RECEIPT_TIMEOUT_MS = 60_000;
const DEFAULT_RECEIPT_POLL_MS = 1_000;

/** The caps as the contract will apply them, plus the two the chain imposes. */
export function capsFor(position: Position, sample: Sample, nowMs: number): Caps {
  const budget = {
    maxPerDay: position.max_per_day,
    spentToday: position.spent_today,
    day: position.day,
    cooldownSecs: position.cooldown_secs,
    lastRescueAtNs: position.last_rescue_at,
  };
  return {
    maxPerRescue: position.max_per_rescue,
    remainingToday: remainingToday(budget, nowMs),
    rescuerBalance: sample.rescuerUsdc,
    rescuerAllowance: sample.rescuerAllowance,
    cooldownRemainingSecs: cooldownRemainingSecs(budget, nowMs),
    paused: position.paused,
  };
}

export function decisionInputFor(
  sample: Sample,
  caps: Caps,
  trigger: bigint,
  target: bigint,
): DecisionInput {
  return {
    healthFactor: sample.healthFactor,
    collateralBase: sample.totalCollateralBase,
    debtBase: sample.totalDebtBase,
    liquidationThresholdBps: sample.liquidationThresholdBps,
    usdcPriceBase: sample.usdcPriceBase,
    usdcDebt: sample.usdcDebt,
    trigger,
    target,
    caps,
  };
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Accumulates a record as the attempt moves through its steps. */
class Attempt {
  readonly record: RunRecord;
  readonly trace: Trace;

  constructor(
    private readonly ctx: RescueContext,
    options: TickOptions,
  ) {
    this.trace = {
      trigger: ctx.position.trigger,
      target: ctx.position.target,
      manual_amount: options.manualAmount?.toString() ?? null,
      quorum: null,
      caps: null,
      decision: null,
      fees: null,
      rescue_result: null,
      signed_tx: null,
      broadcast: null,
      receipt: null,
    };
    this.record = {
      run_id: runId(new Date(ctx.now()), ctx.chain.name, ctx.position.id),
      network: ctx.network,
      position_id: ctx.position.id,
      chain_id: ctx.chain.chainId,
      borrower: ctx.borrower,
      rescuer: ctx.rescuer,
      amount: '0',
      outcome: 'aborted',
      failure_reason: null,
      health_factor_before: null,
      health_factor_after: null,
      timestamps_ms: {
        detected: null,
        near_included: null,
        signed: null,
        broadcast: null,
        included: null,
      },
      near_tx: null,
      evm_tx: null,
      evm_block: null,
      near_contract: ctx.nearContract,
      near_sender: null,
      trace: this.trace,
    };
  }

  noteQuorum(quorum: QuorumResult): void {
    this.trace.quorum = {
      now_ms: quorum.nowMs,
      samples: quorum.samples.map(sampleToTrace),
      failures: quorum.failures,
      refused: quorum.ok ? null : { reason: quorum.reason, detail: quorum.detail },
    };
    this.record.timestamps_ms.detected = quorum.nowMs;
  }

  /** Writes the record, unless a repeating refusal has already been recorded. */
  async finish(outcome: RunOutcome, reason: string | null, detail?: string): Promise<TickResult> {
    const { ctx, record } = this;
    if (outcome === 'aborted' && reason && ctx.allowAbortRecord && !ctx.allowAbortRecord(reason)) {
      return { status: 'quiet', reason };
    }
    record.outcome = outcome;
    record.failure_reason = reason && detail ? `${reason}: ${detail}` : reason;
    const written = await writeRun(ctx.evidenceDir, record);
    const label = reason ? `${outcome} (${record.failure_reason})` : outcome;
    ctx.log(`position ${record.position_id}: ${label}, wrote ${written.path}`);
    return { status: 'recorded', ...written };
  }
}

async function readFeesAndNonce(ctx: RescueContext) {
  const [fees, nonces] = await Promise.all([
    Promise.allSettled(ctx.clients.map((client) => client.readFees())),
    Promise.allSettled(ctx.clients.map((client) => client.readNonce(ctx.rescuer))),
  ]);
  const fulfilled = <T>(results: PromiseSettledResult<T>[]): T[] =>
    results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  return { quotes: fulfilled(fees), nonce: chooseNonce(fulfilled(nonces)) };
}

/** The health factor after the transaction, read at its block where an endpoint can. */
async function readHealthAfter(ctx: RescueContext, blockNumber: bigint): Promise<bigint | null> {
  for (const block of [blockNumber, undefined]) {
    for (const client of ctx.clients) {
      try {
        return await client.readHealthFactor(ctx.chain.pool, ctx.borrower, block);
      } catch (error) {
        ctx.log(`health factor read failed on ${client.url}: ${describeError(error)}`);
      }
    }
  }
  return null;
}

async function sendAndConfirm(
  ctx: RescueContext,
  attempt: Attempt,
  assembled: AssembledTransaction,
): Promise<TickResult> {
  const { record, trace } = attempt;
  const hash: Hex = assembled.hash;
  const clients = ctx.clients;

  record.timestamps_ms.broadcast = ctx.now();
  trace.broadcast = await broadcastToAll(clients, assembled.serialized, hash);
  record.evm_tx = hash;

  const accepted = trace.broadcast.some((result) => result.ok);
  const receipt = await waitForReceipt(clients, hash, {
    // With no endpoint holding it, only a check that it did not land already is useful.
    timeoutMs: accepted ? (ctx.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS) : 0,
    pollMs: ctx.receiptPollMs ?? DEFAULT_RECEIPT_POLL_MS,
    now: ctx.now,
    sleep: ctx.sleep,
  });

  if (!receipt) {
    if (accepted) return attempt.finish('failed', 'receipt_timeout');
    const errors = trace.broadcast.map((result) => `${result.rpc}: ${result.error}`).join('; ');
    return attempt.finish('failed', 'broadcast_rejected', errors);
  }

  record.timestamps_ms.included = ctx.now();
  record.evm_block = Number(receipt.blockNumber);
  trace.receipt = {
    success: receipt.success,
    block_number: receipt.blockNumber.toString(),
    gas_used: receipt.gasUsed.toString(),
    effective_gas_price: receipt.effectiveGasPrice.toString(),
  };

  const healthAfter = await readHealthAfter(ctx, receipt.blockNumber);
  record.health_factor_after = healthAfter === null ? null : formatWad(healthAfter);

  return receipt.success ? attempt.finish('success', null) : attempt.finish('failed', 'evm_reverted');
}

async function signAndSubmit(
  ctx: RescueContext,
  attempt: Attempt,
  decision: Extract<Decision, { action: 'repay' }>,
): Promise<TickResult> {
  const { record, trace } = attempt;
  const { quotes, nonce } = await readFeesAndNonce(ctx);
  const fees = chooseFees(quotes, ctx.ceilings);
  if (!fees.ok) return attempt.finish('aborted', fees.reason, fees.detail);
  if (nonce === null) return attempt.finish('aborted', 'nonce_unavailable');

  const rescueFees = {
    nonce,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  };
  trace.fees = {
    nonce,
    max_fee_per_gas: fees.maxFeePerGas.toString(),
    max_priority_fee_per_gas: fees.maxPriorityFeePerGas.toString(),
  };

  let outcome: Awaited<ReturnType<NearRescuer['rescue']>>;
  try {
    outcome = await ctx.near.rescue({
      id: ctx.position.id,
      amount: decision.amount,
      fees: rescueFees,
    });
  } catch (error) {
    if (error instanceof NearRescueError) {
      record.near_tx = error.nearTx;
      return attempt.finish('failed', error.reason, error.message);
    }
    return attempt.finish('failed', 'near_failed', describeError(error));
  }

  record.near_tx = outcome.nearTx;
  record.near_sender = outcome.nearSender;
  record.timestamps_ms.near_included = outcome.includedAtMs;
  record.timestamps_ms.signed = outcome.signedAtMs;
  trace.rescue_result = outcome.result;

  const intent: RepayIntent = {
    chainId: ctx.chain.chainId,
    pool: ctx.chain.pool,
    usdc: ctx.chain.usdc,
    borrower: ctx.borrower,
    rescuer: ctx.rescuer,
    amount: decision.amount,
    ...rescueFees,
  };

  let assembled: AssembledTransaction;
  try {
    assembled = await assembleSignedTransaction(outcome.result);
    trace.signed_tx = assembled.serialized;
    assertMatchesIntent(assembled, intent);
  } catch (error) {
    if (error instanceof SignatureRefused) {
      return attempt.finish('aborted', error.reason, error.message);
    }
    throw error;
  }

  return sendAndConfirm(ctx, attempt, assembled);
}

async function run(
  ctx: RescueContext,
  attempt: Attempt,
  options: TickOptions,
): Promise<TickResult> {
  const { position } = ctx;
  const { record, trace } = attempt;
  const manual = options.manualAmount !== undefined;

  const quorum = await readQuorum(
    ctx.clients.map((client) => ({
      url: client.url,
      read: () =>
        client.readSample({
          pool: ctx.chain.pool,
          usdc: ctx.chain.usdc,
          borrower: ctx.borrower,
          rescuer: ctx.rescuer,
        }),
    })),
    { ...DEFAULT_QUORUM, chainId: ctx.chain.chainId },
    ctx.now,
  );
  attempt.noteQuorum(quorum);

  if (!quorum.ok) {
    // With every answer above the trigger there is nothing to be refused. Hearing
    // nothing at all is different: the keeper is blind, and that belongs on record.
    const someoneSaysAct = quorum.samples.some((s) => s.healthFactor < position.triggerWad);
    if (!manual && quorum.samples.length > 0 && !someoneSaysAct) {
      return { status: 'idle', reason: `quorum_${quorum.reason}`, healthFactor: null };
    }
    return attempt.finish('aborted', `quorum_${quorum.reason}`, quorum.detail);
  }

  const { sample } = quorum;
  record.health_factor_before = formatWad(sample.healthFactor);
  if (!manual && sample.healthFactor >= position.triggerWad) {
    return { status: 'idle', reason: 'healthy', healthFactor: sample.healthFactor };
  }

  let onContract: Position;
  try {
    onContract = await ctx.views.getPosition(position.id);
  } catch (error) {
    return attempt.finish('aborted', 'position_unavailable', describeError(error));
  }

  const caps = capsFor(onContract, sample, quorum.nowMs);
  trace.caps = capsToTrace(caps);
  const input = decisionInputFor(sample, caps, position.triggerWad, position.targetWad);
  const decision =
    options.manualAmount === undefined ? decide(input) : decideManual(input, options.manualAmount);
  trace.decision = decisionToTrace(decision);

  if (decision.action === 'none') {
    if (decision.blocked) return attempt.finish('aborted', decision.reason);
    return { status: 'idle', reason: decision.reason, healthFactor: sample.healthFactor };
  }

  record.amount = decision.amount.toString();
  ctx.log(
    `position ${position.id}: health factor ${formatWad(sample.healthFactor)} below ${position.trigger}, repaying ${decision.amount} (limited by ${decision.limitedBy})`,
  );
  return signAndSubmit(ctx, attempt, decision);
}

/**
 * Runs one pass. Anything unexpected still ends as a failure on record. The trace is
 * dropped in that case because it may be what failed validation, and losing the
 * detail is better than losing the record.
 */
export async function tick(ctx: RescueContext, options: TickOptions = {}): Promise<TickResult> {
  const attempt = new Attempt(ctx, options);
  try {
    return await run(ctx, attempt, options);
  } catch (error) {
    delete attempt.record.trace;
    return attempt.finish('failed', 'internal_error', describeError(error));
  }
}
