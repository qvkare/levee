/**
 * Replays a recorded run with no keys and no network. Each pure step is computed again
 * from the recorded inputs, so a record that was edited, or a code change that would
 * have decided differently, shows up as a mismatch.
 */
import { isDeepStrictEqual } from 'node:util';
import { type Address, type Hex, keccak256 } from 'viem';
import { chainInfo } from './chains.js';
import { decide, decideManual, formatWad, parseWad } from './decision.js';
import {
  type RunRecord,
  SIMULATED,
  type Trace,
  capsFromTrace,
  decisionToTrace,
  modeOf,
  quoteAnswersFromTrace,
  sampleFromTrace,
  swapToRecord,
} from './evidence.js';
import { DEFAULT_QUORUM, type QuorumResult, type Sample, evaluateQuorum } from './quorum.js';
import { collateralDecisionInputFor, decisionInputFor } from './rescue.js';
import {
  type AssembledTransaction,
  SignatureRefused,
  assembleSignedTransaction,
  assertMatchesIntent,
  assertMatchesUnwindIntent,
  decodeRepay,
} from './signature.js';
import {
  chooseMaxSold,
  decodeUnwind,
  decodeUnwound,
  isAboveTrigger,
  oracleMaxIn,
  swapPrice,
} from './unwind.js';

export interface ReplayStep {
  title: string;
  /** True or false if this step was recomputed, null if it could only be shown. */
  ok: boolean | null;
  lines: string[];
}

export interface ReplayResult {
  steps: ReplayStep[];
  /** No recomputed step disagreed with the record. */
  ok: boolean;
}

function headerStep(run: RunRecord): ReplayStep {
  const lines = [
    `network ${run.network}, chain ${run.chain_id}, position ${run.position_id}, ${modeOf(run)} mode`,
    `borrower ${run.borrower}`,
    `rescuer  ${run.rescuer}`,
    `outcome  ${run.outcome}${run.failure_reason ? ` (${run.failure_reason})` : ''}`,
  ];
  if (run.network === SIMULATED) {
    lines.unshift('SIMULATED: a local key stood in for the MPC. This proves nothing about mainnet.');
  }
  return { title: `Run ${run.run_id}`, ok: null, lines };
}

function quorumStep(
  run: RunRecord,
  quorum: NonNullable<Trace['quorum']>,
): { step: ReplayStep; result: QuorumResult } {
  const samples = quorum.samples.map(sampleFromTrace);
  const result = evaluateQuorum(samples, quorum.failures, {
    ...DEFAULT_QUORUM,
    chainId: run.chain_id,
    nowMs: quorum.now_ms,
  });

  const lines = samples.map(
    (s: Sample) =>
      `${s.rpc}: block ${s.blockNumber}, health factor ${formatWad(s.healthFactor)}, debt ${s.totalDebtBase}`,
  );
  for (const failure of quorum.failures) lines.push(`${failure.rpc}: ${failure.error}`);

  const recordedReason = quorum.refused?.reason ?? null;
  const replayedReason = result.ok ? null : result.reason;
  lines.push(
    replayedReason ? `refused: ${replayedReason}` : `agreed, acting on ${result.ok ? result.sample.rpc : ''}`,
  );
  return {
    step: { title: 'Quorum', ok: recordedReason === replayedReason, lines },
    result,
  };
}

function decisionStep(run: RunRecord, trace: Trace, sample: Sample): ReplayStep | null {
  if (!trace.caps || !trace.decision) return null;
  const caps = capsFromTrace(trace.caps);
  if (modeOf(run) === 'collateral' && (!trace.collateral || !sample.collateral)) {
    return {
      title: 'Decision',
      ok: false,
      lines: ['a collateral run without its collateral terms cannot be recomputed'],
    };
  }
  const input = trace.collateral
    ? collateralDecisionInputFor(sample, caps, BigInt(trace.collateral.pool_fee))
    : decisionInputFor(sample, caps, parseWad(trace.trigger), parseWad(trace.target));
  const manual = trace.manual_amount;
  const replayed = decisionToTrace(
    manual === null ? decide(input) : decideManual(input, BigInt(manual)),
  );

  const lines = [
    trace.collateral
      ? `trigger ${formatWad(input.trigger)}, target ${formatWad(input.target)} at the helper`
      : `trigger ${trace.trigger}, target ${trace.target}`,
  ];
  if (manual !== null) lines.push(`fired by hand for ${manual}`);
  lines.push(
    replayed.action === 'repay'
      ? `repay ${replayed.amount} of ${replayed.needed} needed, limited by ${replayed.limited_by}`
      : `no action: ${replayed.reason}`,
  );
  return { title: 'Decision', ok: isDeepStrictEqual(replayed, trace.decision), lines };
}

/**
 * Collateral mode: `max_sold` chosen again from the recorded QuoterV2 answers, and the
 * helper's oracle bound computed again from the sample the decision used.
 */
function quoteStep(run: RunRecord, trace: Trace, sample: Sample | null): ReplayStep | null {
  const { quote } = trace;
  if (!quote) return null;
  const lines = quote.answers.map(
    (answer) => `${answer.rpc}: ${answer.amount_in ?? answer.error}`,
  );
  let ok = true;
  if (sample?.collateral) {
    const bound = oracleMaxIn(BigInt(quote.amount), sample.collateral, sample.usdcPriceBase);
    lines.push(`oracle bound ${bound} for ${quote.amount} USDC units`);
    ok = bound.toString() === quote.oracle_max_in;
  }
  const choice = chooseMaxSold(quoteAnswersFromTrace(quote.answers), {
    amount: BigInt(quote.amount),
    toleranceBps: BigInt(quote.tolerance_bps),
    minAnswers: DEFAULT_QUORUM.minEndpoints,
    maxDeviationBps: DEFAULT_QUORUM.maxDeviationBps,
    oracleMaxIn: BigInt(quote.oracle_max_in),
  });
  const amountIn = choice.amountIn === null ? null : choice.amountIn.toString();
  const maxSold = choice.ok ? choice.maxSold.toString() : null;
  lines.push(
    choice.ok
      ? `max_sold ${maxSold}: quote ${amountIn} plus ${quote.tolerance_bps} bps`
      : `refused: ${choice.reason}`,
  );
  ok =
    ok &&
    amountIn === quote.amount_in &&
    maxSold === quote.max_sold &&
    maxSold === (run.max_sold ?? null) &&
    (choice.ok || run.failure_reason?.startsWith(choice.reason) === true);
  return { title: 'Quote', ok, lines };
}

function feesStep(trace: Trace): ReplayStep | null {
  if (!trace.fees) return null;
  const { nonce, max_fee_per_gas: maxFee, max_priority_fee_per_gas: priority } = trace.fees;
  return {
    title: 'Fees',
    ok: null,
    lines: [`nonce ${nonce}, max fee ${maxFee}, priority fee ${priority}`],
  };
}

function nearStep(run: RunRecord): ReplayStep | null {
  if (!run.near_tx) return null;
  return {
    title: 'NEAR rescue',
    ok: null,
    lines: [`transaction ${run.near_tx}`, `sent by ${run.near_sender} to ${run.near_contract}`],
  };
}

async function signatureStep(run: RunRecord, trace: Trace): Promise<ReplayStep | null> {
  if (!trace.rescue_result) return null;
  const chain = chainInfo(run.chain_id);
  const lines: string[] = [];
  // A rescue result in an aborted record with nothing broadcast means the gate refused
  // it, so a pass here contradicts the record. An abort after a broadcast, such as
  // `above_trigger`, passed the gate.
  const refusedInRecord = run.outcome === 'aborted' && run.evm_tx === null;

  try {
    const assembled = await assembleSignedTransaction(trace.rescue_result);
    lines.push(`recovered signer ${assembled.signer}`);
    if (trace.fees) {
      const common = {
        chainId: run.chain_id,
        borrower: run.borrower as Address,
        rescuer: run.rescuer as Address,
        amount: BigInt(run.amount),
        nonce: trace.fees.nonce,
        maxFeePerGas: BigInt(trace.fees.max_fee_per_gas),
        maxPriorityFeePerGas: BigInt(trace.fees.max_priority_fee_per_gas),
      };
      if (modeOf(run) === 'collateral') {
        if (!trace.collateral) {
          throw new SignatureRefused('intent_mismatch', 'a collateral run with no collateral terms');
        }
        if (!run.max_sold) {
          throw new SignatureRefused('intent_mismatch', 'a collateral run with no max_sold');
        }
        assertMatchesUnwindIntent(assembled, {
          ...common,
          helper: trace.collateral.helper as Address,
          collateral: trace.collateral.asset as Address,
          poolFee: BigInt(trace.collateral.pool_fee),
          maxSold: BigInt(run.max_sold),
        });
      } else {
        assertMatchesIntent(assembled, { ...common, pool: chain.pool, usdc: chain.usdc });
      }
    }
    lines.push(describeCall(assembled));
    const sameBytes = trace.signed_tx === null || trace.signed_tx === assembled.serialized;
    return { title: 'Signature', ok: sameBytes && !refusedInRecord, lines };
  } catch (error) {
    if (!(error instanceof SignatureRefused)) throw error;
    lines.push(`refused: ${error.reason}: ${error.message}`);
    return {
      title: 'Signature',
      ok: run.failure_reason?.startsWith(error.reason) === true,
      lines,
    };
  }
}

function describeCall(assembled: AssembledTransaction): string {
  const data = assembled.tx.data ?? '0x';
  const unwind = decodeUnwind(data);
  if (unwind) {
    return `unwind ${unwind.amount} for ${unwind.borrower}, selling at most ${unwind.maxSold} of ${unwind.collateral} at fee ${unwind.poolFee}`;
  }
  const repay = decodeRepay(data);
  return `repay ${repay?.amount} of ${repay?.asset} on behalf of ${repay?.onBehalfOf}`;
}

/** Collateral mode: the helper's account of the swap, priced again from the trace. */
function swapStep(run: RunRecord, trace: Trace): ReplayStep | null {
  if (!trace.unwound) return null;
  const { log, decimals, collateral_price_base: collateralPrice, usdc_price_base: usdcPrice } =
    trace.unwound;
  const unwound = decodeUnwound({
    address: log.address as Address,
    topics: log.topics as Hex[],
    data: log.data as Hex,
  });
  if (!unwound) {
    return { title: 'Swap', ok: false, lines: ['the recorded log is not an Unwound event'] };
  }
  const lines = [
    `repaid ${unwound.repaid} USDC units, sold ${unwound.sold} of ${unwound.collateral}`,
  ];
  let ok = run.sold === unwound.sold.toString();
  if (collateralPrice !== null && usdcPrice !== null) {
    const swap = swapToRecord(
      swapPrice(unwound, BigInt(decimals), BigInt(collateralPrice), BigInt(usdcPrice)),
    );
    lines.push(
      `effective price ${swap.effective_price_base} against oracle ${swap.collateral_price_base}, ${swap.discount_bps} bps below`,
    );
    ok = ok && isDeepStrictEqual(swap, run.swap);
  } else {
    lines.push('no oracle price on record');
    ok = ok && (run.swap ?? null) === null;
  }
  return { title: 'Swap', ok, lines };
}

/** Collateral mode: why a reverted unwind reverted, and whether the record agrees. */
function revertStep(run: RunRecord, trace: Trace): ReplayStep | null {
  if (!trace.revert) return null;
  const aboveTrigger = isAboveTrigger(trace.revert.data);
  const lines = [
    `revert data ${trace.revert.data ?? 'none'}: ${trace.revert.error}`,
    aboveTrigger
      ? 'the health factor was above the trigger again: a no-op'
      : 'not the above-trigger refusal',
  ];
  return { title: 'Revert', ok: aboveTrigger === (run.failure_reason === 'above_trigger'), lines };
}

function broadcastStep(run: RunRecord, trace: Trace): ReplayStep | null {
  if (!trace.broadcast || !trace.signed_tx) return null;
  const lines = trace.broadcast.map(
    (attempt) => `${attempt.rpc}: ${attempt.ok ? 'accepted' : attempt.error}`,
  );
  const hash = keccak256(trace.signed_tx as Hex);
  lines.push(`transaction ${hash}`);
  return { title: 'Broadcast', ok: hash === run.evm_tx, lines };
}

function receiptStep(run: RunRecord, trace: Trace): ReplayStep | null {
  if (!trace.receipt) return null;
  const { success, block_number: block, gas_used: gas } = trace.receipt;
  return {
    title: 'Receipt',
    ok: run.evm_block !== null && BigInt(block) === BigInt(run.evm_block),
    lines: [
      `${success ? 'success' : 'reverted'} in block ${block}, gas ${gas}`,
      `health factor ${run.health_factor_before} to ${run.health_factor_after}`,
    ],
  };
}

function timelineStep(run: RunRecord): ReplayStep {
  const { detected } = run.timestamps_ms;
  const lines = Object.entries(run.timestamps_ms).map(([name, at]) => {
    if (at === null) return `${name.padEnd(14)} not reached`;
    return `${name.padEnd(14)} +${detected === null ? at : at - detected} ms`;
  });
  return { title: 'Timeline', ok: null, lines };
}

/** Replays a record. Pure apart from CPU: it opens no connection and reads no key. */
export async function replayRun(run: RunRecord): Promise<ReplayResult> {
  const steps: ReplayStep[] = [headerStep(run)];
  const { trace } = run;

  if (!trace) {
    steps.push({
      title: 'Trace',
      ok: null,
      lines: ['this record has no trace, so no step can be recomputed'],
    });
  } else {
    let sample: Sample | null = null;
    if (trace.quorum) {
      const { step, result } = quorumStep(run, trace.quorum);
      steps.push(step);
      if (result.ok) {
        sample = result.sample;
        const decision = decisionStep(run, trace, result.sample);
        if (decision) steps.push(decision);
      }
    }
    const signature = await signatureStep(run, trace);
    const remaining = [
      feesStep(trace),
      quoteStep(run, trace, sample),
      nearStep(run),
      signature,
      broadcastStep(run, trace),
      receiptStep(run, trace),
      swapStep(run, trace),
      revertStep(run, trace),
    ];
    steps.push(...remaining.filter((step) => step !== null));
  }

  steps.push(timelineStep(run));
  return { steps, ok: steps.every((step) => step.ok !== false) };
}

const MARK = { true: 'ok', false: 'MISMATCH', null: 'shown' } as const;

/** The text `replay` prints. */
export function formatReplay(result: ReplayResult): string {
  const lines: string[] = [];
  result.steps.forEach((step, index) => {
    lines.push(`${index + 1}. ${step.title} [${MARK[String(step.ok) as keyof typeof MARK]}]`);
    for (const line of step.lines) lines.push(`   ${line}`);
  });
  lines.push(
    '',
    result.ok
      ? 'Replay matches the record.'
      : 'Replay DOES NOT match the record. See the steps marked MISMATCH.',
  );
  return lines.join('\n');
}
