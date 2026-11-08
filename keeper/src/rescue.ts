/**
 * One pass of the keeper loop for one position, spec sections 5 and 9. Every attempt
 * that gets as far as wanting to act ends in a run record, including the ones that fail.
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
  quoteAnswersToTrace,
  sampleToTrace,
  swapToRecord,
  writeRun,
} from './evidence.js';
import type { EvmClient, EvmReceipt } from './evm.js';
import { type FeeCeilings, chooseFees, chooseNonce } from './fees.js';
import {
  NearRescueError,
  type NearRescuer,
  type NearViews,
  type Position,
  type RescueMode,
} from './near.js';
import {
  type CollateralSample,
  DEFAULT_QUORUM,
  type QuorumResult,
  type Sample,
  readQuorum,
} from './quorum.js';
import {
  type AssembledTransaction,
  SignatureRefused,
  assembleSignedTransaction,
  assertMatchesIntent,
  assertMatchesUnwindIntent,
} from './signature.js';
import {
  DEFAULT_QUOTE_TOLERANCE_BPS,
  type MaxSoldChoice,
  type QuoteAnswer,
  chooseMaxSold,
  decodeUnwound,
  helperConfigMismatch,
  isAboveTrigger,
  oracleMaxIn,
  swapPrice,
  unwoundEvents,
} from './unwind.js';

export interface PositionTarget {
  id: number;
  /** Decimal strings as configured, kept for the record. */
  trigger: string;
  target: string;
  triggerWad: bigint;
  targetWad: bigint;
  /** Absent means reserve. */
  mode?: RescueMode;
  /** Collateral mode: the borrower's slippage limit, as set at the helper. */
  maxSlippageBps?: bigint;
  /** Collateral mode: headroom over a fresh quote for `max_sold`. Defaults to 50 bps. */
  quoteToleranceBps?: bigint;
}

/** Collateral mode: what the contract signs for, read from it at start. */
export interface CollateralContext {
  /** The position's collateral asset, from `get_position`. */
  asset: Address;
  /** The chain's `LeveeUnwind`, from `get_chain`. */
  helper: Address;
  /** Uniswap v3 fee tier, from `get_position`. */
  poolFee: bigint;
  /** The chain's Uniswap v3 QuoterV2, which `max_sold` is quoted from. */
  quoter: Address;
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
  /** Set for a position in collateral mode, and only then. */
  collateral?: CollateralContext;
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

/**
 * Collateral mode. The trigger, target and slippage are the borrower's own, read from
 * the helper in the same sample, because those are what `unwind` enforces.
 */
export function collateralDecisionInputFor(sample: Sample, caps: Caps, poolFee: bigint): DecisionInput {
  const collateral = sample.collateral;
  if (!collateral) throw new Error('a collateral decision needs a collateral sample');
  return {
    ...decisionInputFor(sample, caps, collateral.triggerHf, collateral.targetHf),
    collateral: {
      priceBase: collateral.priceBase,
      decimals: collateral.decimals,
      liquidationThresholdBps: collateral.liquidationThresholdBps,
      aTokenBalance: collateral.aTokenBalance,
      aTokenAllowance: collateral.aTokenAllowance,
      poolFee,
      maxSlippageBps: collateral.maxSlippageBps,
    },
  };
}

/** What the borrower set at the helper, as the sample read it. */
export const helperConfigOfSample = (held: CollateralSample) => ({
  rescuer: held.authorizedRescuer,
  maxSlippageBps: held.maxSlippageBps,
  triggerHf: held.triggerHf,
  targetHf: held.targetHf,
  collateral: held.authorizedCollateral,
  poolFee: held.authorizedPoolFee,
});

const modeOf = (ctx: Pick<RescueContext, 'collateral'>): RescueMode =>
  ctx.collateral ? 'collateral' : 'reserve';

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
      mode: modeOf(ctx),
      trace: this.trace,
    };
    if (ctx.collateral) {
      const { asset, helper, poolFee } = ctx.collateral;
      Object.assign(this.record, { collateral: asset, max_sold: null, sold: null, swap: null });
      Object.assign(this.trace, {
        collateral: { asset, helper, pool_fee: poolFee.toString() },
        quote: null,
        unwound: null,
        revert: null,
      });
    }
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
    // Only a refusal that never reached the lending chain can repeat for free. An abort
    // after a broadcast, such as `above_trigger`, spent gas and is always recorded.
    const repeatable = outcome === 'aborted' && record.evm_tx === null;
    if (repeatable && reason && ctx.allowAbortRecord && !ctx.allowAbortRecord(reason)) {
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

  if (ctx.collateral && receipt.success) await noteUnwound(ctx, attempt, receipt);
  if (ctx.collateral && !receipt.success) {
    const revert = await readRevert(ctx, assembled, receipt.blockNumber);
    trace.revert = revert;
    // The health factor recovered between the read and inclusion, and the helper
    // refused. Nothing moved but gas, which is a no-op, not a failed rescue.
    if (isAboveTrigger(revert?.data)) return attempt.finish('aborted', 'above_trigger');
    return attempt.finish('failed', 'evm_reverted', revert?.data?.slice(0, 10) ?? revert?.error);
  }

  return receipt.success ? attempt.finish('success', null) : attempt.finish('failed', 'evm_reverted');
}

/** The first answer any endpoint gives, or null if none does. */
async function firstAnswer<T>(
  ctx: RescueContext,
  what: string,
  read: (client: EvmClient) => Promise<T>,
): Promise<T | null> {
  for (const client of ctx.clients) {
    try {
      return await read(client);
    } catch (error) {
      ctx.log(`${what} failed on ${client.url}: ${describeError(error)}`);
    }
  }
  return null;
}

/**
 * Reads what the helper sold from its `Unwound` event, and prices it against Aave's
 * oracle at the same block. The event is the helper's own account of the swap.
 */
async function noteUnwound(ctx: RescueContext, attempt: Attempt, receipt: EvmReceipt): Promise<void> {
  const collateral = ctx.collateral as CollateralContext;
  const log = (receipt.logs ?? []).find(
    (candidate) => unwoundEvents([candidate], collateral.helper).length > 0,
  );
  const event = log ? decodeUnwound(log) : null;
  if (!event || !log) {
    ctx.log(`position ${ctx.position.id}: no Unwound event from ${collateral.helper}`);
    return;
  }
  const decimals = attempt.trace.quorum?.samples[0]?.collateral?.decimals ?? null;
  const prices = await firstAnswer(ctx, 'oracle read', (client) =>
    client.readAssetPrices(ctx.chain.pool, [collateral.asset, ctx.chain.usdc], receipt.blockNumber),
  );
  const [collateralPrice, usdcPrice] = prices ?? [];
  attempt.record.sold = event.sold.toString();
  attempt.trace.unwound = {
    log,
    decimals: decimals ?? '0',
    collateral_price_base: collateralPrice?.toString() ?? null,
    usdc_price_base: usdcPrice?.toString() ?? null,
  };
  if (decimals !== null && collateralPrice !== undefined && usdcPrice !== undefined) {
    attempt.record.swap = swapToRecord(
      swapPrice(event, BigInt(decimals), collateralPrice, usdcPrice),
    );
  }
}

/**
 * Replays the reverted call on the state at its block to read why it reverted, since a
 * receipt does not say. Calls after it in the same block are in that state too, so the
 * answer is the likely reason, not a proof.
 */
async function readRevert(
  ctx: RescueContext,
  assembled: AssembledTransaction,
  blockNumber: bigint,
): Promise<NonNullable<Trace['revert']> | null> {
  const { tx } = assembled;
  if (!tx.to) return null;
  const call = { from: ctx.rescuer, to: tx.to, data: tx.data ?? '0x', gas: tx.gas ?? 0n };
  const result = await firstAnswer(ctx, 'revert replay', (client) =>
    client.simulate(call, blockNumber),
  );
  if (!result) return null;
  if (!result.reverted) return { data: null, error: 'the call no longer reverts at its block' };
  return { data: result.data, error: result.error };
}

/**
 * Collateral mode: `max_sold` from a fresh QuoterV2 quote on every endpoint, for the
 * same pool and amount, plus the position's tolerance. Taken just before the NEAR call,
 * because the NEAR contract publishes the signed transaction before it lands and a
 * searcher could otherwise sandwich it up to the borrower's whole slippage bound.
 */
async function quoteMaxSold(
  ctx: RescueContext,
  attempt: Attempt,
  sample: Sample,
  amount: bigint,
): Promise<MaxSoldChoice> {
  const collateral = ctx.collateral as CollateralContext;
  const held = sample.collateral as CollateralSample;
  const toleranceBps = ctx.position.quoteToleranceBps ?? DEFAULT_QUOTE_TOLERANCE_BPS;
  const bound = oracleMaxIn(amount, held, sample.usdcPriceBase);
  const sale = {
    tokenIn: collateral.asset,
    tokenOut: ctx.chain.usdc,
    amount,
    fee: collateral.poolFee,
  };
  const settled = await Promise.allSettled(
    ctx.clients.map((client) => client.quoteExactOutput(collateral.quoter, sale)),
  );
  const answers: QuoteAnswer[] = settled.map((result, index) => ({
    rpc: ctx.clients[index]?.url ?? '',
    amountIn: result.status === 'fulfilled' ? result.value : null,
    error: result.status === 'rejected' ? describeError(result.reason) : null,
  }));
  const choice = chooseMaxSold(answers, {
    amount,
    toleranceBps,
    minAnswers: DEFAULT_QUORUM.minEndpoints,
    maxDeviationBps: DEFAULT_QUORUM.maxDeviationBps,
    oracleMaxIn: bound,
  });
  attempt.trace.quote = {
    quoter: collateral.quoter,
    amount: amount.toString(),
    pool_fee: collateral.poolFee.toString(),
    tolerance_bps: toleranceBps.toString(),
    oracle_max_in: bound.toString(),
    answers: quoteAnswersToTrace(answers),
    amount_in: choice.amountIn === null ? null : choice.amountIn.toString(),
    max_sold: choice.ok ? choice.maxSold.toString() : null,
  };
  return choice;
}

async function signAndSubmit(
  ctx: RescueContext,
  attempt: Attempt,
  decision: Extract<Decision, { action: 'repay' }>,
  sample: Sample,
): Promise<TickResult> {
  const { record, trace } = attempt;
  const { quotes, nonce } = await readFeesAndNonce(ctx);
  const fees = chooseFees(quotes, ctx.ceilings);
  if (!fees.ok) return attempt.finish('aborted', fees.reason, fees.detail);
  if (nonce === null) return attempt.finish('aborted', 'nonce_unavailable');

  let maxSold: bigint | undefined;
  if (ctx.collateral) {
    const choice = await quoteMaxSold(ctx, attempt, sample, decision.amount);
    if (!choice.ok) return attempt.finish('aborted', choice.reason, choice.detail);
    maxSold = choice.maxSold;
    record.max_sold = maxSold.toString();
  }

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
      ...(ctx.collateral ? { mode: 'collateral' as const, maxSold } : {}),
    });
  } catch (error) {
    if (error instanceof NearRescueError) {
      record.near_tx = error.nearTx;
      record.near_sender = error.nearSender;
      return attempt.finish('failed', error.reason, error.message);
    }
    return attempt.finish('failed', 'near_failed', describeError(error));
  }

  record.near_tx = outcome.nearTx;
  record.near_sender = outcome.nearSender;
  record.timestamps_ms.near_included = outcome.includedAtMs;
  record.timestamps_ms.signed = outcome.signedAtMs;
  trace.rescue_result = outcome.result;

  const common = {
    chainId: ctx.chain.chainId,
    borrower: ctx.borrower,
    rescuer: ctx.rescuer,
    amount: decision.amount,
    ...rescueFees,
  };

  let assembled: AssembledTransaction;
  try {
    assembled = await assembleSignedTransaction(outcome.result);
    trace.signed_tx = assembled.serialized;
    if (ctx.collateral) {
      const { helper, asset, poolFee } = ctx.collateral;
      assertMatchesUnwindIntent(assembled, {
        ...common,
        helper,
        collateral: asset,
        poolFee,
        maxSold: maxSold as bigint,
      });
    } else {
      assertMatchesIntent(assembled, { ...common, pool: ctx.chain.pool, usdc: ctx.chain.usdc });
    }
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

  const query = {
    pool: ctx.chain.pool,
    usdc: ctx.chain.usdc,
    borrower: ctx.borrower,
    rescuer: ctx.rescuer,
    ...(ctx.collateral
      ? { collateral: { asset: ctx.collateral.asset, helper: ctx.collateral.helper } }
      : {}),
  };
  const quorum = await readQuorum(
    ctx.clients.map((client) => ({ url: client.url, read: () => client.readSample(query) })),
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

  // Collateral mode acts on the borrower's own settings at the helper. They were
  // checked against the keeper's at start, and a change since stops the keeper.
  let trigger = position.triggerWad;
  if (ctx.collateral) {
    if (!sample.collateral) return attempt.finish('aborted', 'collateral_unavailable');
    const mismatch = helperConfigMismatch(
      { ...position, collateral: ctx.collateral.asset, poolFee: ctx.collateral.poolFee },
      helperConfigOfSample(sample.collateral),
      ctx.rescuer,
    );
    if (mismatch) return attempt.finish('aborted', 'helper_config_mismatch', mismatch);
    trigger = sample.collateral.triggerHf;
  }
  if (!manual && sample.healthFactor >= trigger) {
    return { status: 'idle', reason: 'healthy', healthFactor: sample.healthFactor };
  }
  // Aave would revert the aToken transfer with LtvValidationFailed, so the unwind would
  // only burn gas. Only the borrower can clear it, by withdrawing or disabling the asset.
  const blocker = sample.collateral?.ltvZeroCollateral;
  if (ctx.collateral && blocker) {
    return attempt.finish(
      'aborted',
      'ltv_zero_collateral',
      `${blocker} is enabled as collateral at LTV 0, so Aave lets no other collateral leave the account before it`,
    );
  }

  let onContract: Position;
  try {
    onContract = await ctx.views.getPosition(position.id);
  } catch (error) {
    return attempt.finish('aborted', 'position_unavailable', describeError(error));
  }

  const caps = capsFor(onContract, sample, quorum.nowMs);
  trace.caps = capsToTrace(caps);
  const input = ctx.collateral
    ? collateralDecisionInputFor(sample, caps, ctx.collateral.poolFee)
    : decisionInputFor(sample, caps, position.triggerWad, position.targetWad);
  const decision =
    options.manualAmount === undefined ? decide(input) : decideManual(input, options.manualAmount);
  trace.decision = decisionToTrace(decision);

  if (decision.action === 'none') {
    if (decision.blocked) return attempt.finish('aborted', decision.reason);
    return { status: 'idle', reason: decision.reason, healthFactor: sample.healthFactor };
  }

  record.amount = decision.amount.toString();
  ctx.log(
    `position ${position.id}: health factor ${formatWad(sample.healthFactor)} below ${formatWad(trigger)}, repaying ${decision.amount} from ${modeOf(ctx)} (limited by ${decision.limitedBy})`,
  );
  return signAndSubmit(ctx, attempt, decision, sample);
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
