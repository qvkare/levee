/**
 * Replays a recorded run with no keys and no network. Each pure step is computed again
 * from the recorded inputs, so a record that was edited, or a code change that would
 * have decided differently, shows up as a mismatch.
 */
import { isDeepStrictEqual } from 'node:util';
import { type Hex, keccak256 } from 'viem';
import { chainInfo } from './chains.js';
import { decide, decideManual, formatWad, parseWad } from './decision.js';
import {
  type RunRecord,
  SIMULATED,
  type Trace,
  capsFromTrace,
  decisionToTrace,
  sampleFromTrace,
} from './evidence.js';
import { DEFAULT_QUORUM, type QuorumResult, type Sample, evaluateQuorum } from './quorum.js';
import { decisionInputFor } from './rescue.js';
import {
  SignatureRefused,
  assembleSignedTransaction,
  assertMatchesIntent,
  decodeRepay,
} from './signature.js';

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
    `network ${run.network}, chain ${run.chain_id}, position ${run.position_id}`,
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

function decisionStep(trace: Trace, sample: Sample): ReplayStep | null {
  if (!trace.caps || !trace.decision) return null;
  const input = decisionInputFor(
    sample,
    capsFromTrace(trace.caps),
    parseWad(trace.trigger),
    parseWad(trace.target),
  );
  const manual = trace.manual_amount;
  const replayed = decisionToTrace(
    manual === null ? decide(input) : decideManual(input, BigInt(manual)),
  );

  const lines = [`trigger ${trace.trigger}, target ${trace.target}`];
  if (manual !== null) lines.push(`fired by hand for ${manual}`);
  lines.push(
    replayed.action === 'repay'
      ? `repay ${replayed.amount} of ${replayed.needed} needed, limited by ${replayed.limited_by}`
      : `no action: ${replayed.reason}`,
  );
  return { title: 'Decision', ok: isDeepStrictEqual(replayed, trace.decision), lines };
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
  // A rescue result in an aborted record means the gate refused it, so a pass here
  // contradicts the record.
  const refusedInRecord = run.outcome === 'aborted';

  try {
    const assembled = await assembleSignedTransaction(trace.rescue_result);
    lines.push(`recovered signer ${assembled.signer}`);
    if (trace.fees) {
      assertMatchesIntent(assembled, {
        chainId: run.chain_id,
        pool: chain.pool,
        usdc: chain.usdc,
        borrower: run.borrower as Hex,
        rescuer: run.rescuer as Hex,
        amount: BigInt(run.amount),
        nonce: trace.fees.nonce,
        maxFeePerGas: BigInt(trace.fees.max_fee_per_gas),
        maxPriorityFeePerGas: BigInt(trace.fees.max_priority_fee_per_gas),
      });
    }
    const repay = decodeRepay(assembled.tx.data ?? '0x');
    lines.push(`repay ${repay?.amount} of ${repay?.asset} on behalf of ${repay?.onBehalfOf}`);
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
    if (trace.quorum) {
      const { step, result } = quorumStep(run, trace.quorum);
      steps.push(step);
      if (result.ok) {
        const decision = decisionStep(trace, result.sample);
        if (decision) steps.push(decision);
      }
    }
    const signature = await signatureStep(run, trace);
    const remaining = [
      feesStep(trace),
      nearStep(run),
      signature,
      broadcastStep(run, trace),
      receiptStep(run, trace),
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
