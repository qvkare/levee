/**
 * Every figure the site states about Levee itself, worked out in one place: the run records, the
 * signing test, the fork rehearsal and the backtest summary. Pages read the result through PROOF in
 * proof.ts, so no two pages can print a different number for the same thing. Pure.
 */
import { MISS_NAMES, honestFigures, type Backtest, type MissReason } from "./backtest.ts";
import { CHAIN_NAMES, evmLink, latencyTable, nearLink, percentile, tally, type EvidenceRun, type LatencyRow, type MpcLatency, type Outcome, type Rehearsal, type Tally } from "./evidence.ts";

export interface Link {
  href: string;
  label: string;
}

/** Milliseconds from detection to each later moment of a run. Null where the run did not get there. */
export interface Marks {
  near: number | null;
  signed: number | null;
  sent: number | null;
  included: number | null;
}

export interface ProofRun {
  id: string;
  outcome: Outcome;
  /** Detection, in milliseconds since the epoch. */
  detectedAt: number | null;
  /** 19:27:38, UTC. */
  time: string | null;
  chain: string;
  marks: Marks;
  totalMs: number | null;
  /** 7.85 USDC. Null when nothing was repaid. */
  amount: string | null;
  healthBefore: string | null;
  healthAfter: string | null;
  /** As the keeper recorded it. */
  reason: string | null;
  /** The same, in words, when the reason is one the site knows. */
  why: string | null;
  near: Link | null;
  evm: Link | null;
  evmBlock: number | null;
  /** The run the home page replays. */
  replayed: boolean;
}

/** The run the home page replays: the landed run whose total is the median of all landed runs. */
export interface Replay {
  id: string;
  detectedAt: number;
  chain: string;
  network: string;
  contract: string | null;
  amount: string;
  healthBefore: number;
  healthAfter: number;
  trigger: number | null;
  target: number | null;
  marks: { near: number; signed: number; sent: number; included: number };
  block: number | null;
  near: Link;
  evm: Link;
  /**
   * The fall before detection, which no record times. Health factor goes from `from` to the reading
   * at detection, drawn as debt rising against the collateral the keeper read: `counted` is that
   * collateral at its liquidation threshold, `debtAt` the debt at detection, both in USD.
   */
  before: { from: number; counted: number; debtAt: number } | null;
}

export interface Signing extends MpcLatency {
  links: Array<Link | null>;
}

export interface RehearsalFigures {
  label: string;
  amount: string | null;
  healthBefore: string | null;
  healthAfter: string | null;
  latencyMs: number | null;
  near: Link | null;
}

/** One reserve size. Counts of positions that survived, out of `positions`. */
export interface BacktestRow {
  share: number;
  positions: number;
  levee: number;
  /** The same USDC repaid at the start, with no keeper. */
  upfront: number;
  /** The same USDC held as Aave collateral, with no keeper. */
  collateral: number;
}

export interface BacktestFigures {
  positions: number;
  trigger: number;
  target: number;
  delaySec: number;
  /** The reserve size the detailed figures are for. */
  reserveShare: number;
  windows: string[];
  chains: string[];
  rows: BacktestRow[];
  /** Repaying the same USDC at the start did at least as well as Levee at every reserve size. */
  upfrontNeverWorse: boolean;
  /** Reserve sizes where plain collateral survived more often than both. */
  collateralBeatsBoth: number[];
  saved: number;
  notSaved: number;
  armedBelow: number;
  armedAbove: number;
  savedArmedAbove: number;
  bothSurvive: number;
  collateralOnly: number;
  failedLaterInWindow: number;
  misses: Array<{ reason: MissReason; name: string; count: number }>;
  excluded: number;
  topExclusions: Array<{ reason: string; positions: number }>;
  byWindow: Array<{ label: string; positions: number; saved: number }>;
  liquidatedDebtUsd: number;
  reserveUsedOnSavedUsd: number;
  reserveHeldUsd: number;
}

export interface Proof {
  /** Newest first, every outcome. */
  runs: ProofRun[];
  counts: Tally;
  /** The days the runs were made on: 7 Nov 2026. */
  days: string;
  /** The Levee contracts the runs called. */
  contracts: string[];
  /** The trigger the keeper used, when every run used the same one. */
  trigger: number | null;
  hops: LatencyRow[];
  overall: LatencyRow;
  replay: Replay | null;
  signing: Signing | null;
  rehearsal: RehearsalFigures | null;
  backtest: BacktestFigures | null;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 7 Nov 2026, in UTC. */
export function day(ms: number): string {
  const date = new Date(ms);
  return `${date.getUTCDate()} ${SHORT_MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** 2025-10 as October 2025. Anything else is left as it is. */
export function monthName(key: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  return match && month ? `${month} ${match[1]}` : key;
}

/** Run ids start with the detection time: 2026-11-07T19-27-38Z. */
function idTime(id: string): number | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z/.exec(id);
  return match ? Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`) : null;
}

/** USDC has 6 decimals and amounts are recorded in base units. Rounded down to the cent, with no float. */
export function usdcAmount(baseUnits: string | null): string | null {
  if (!baseUnits || !/^\d+$/.test(baseUnits) || /^0+$/.test(baseUnits)) return null;
  const padded = baseUnits.padStart(7, "0");
  const whole = Number(padded.slice(0, -6)).toLocaleString("en-US");
  return `${whole}.${padded.slice(-6, -4)} USDC`;
}

const FIELD_WORDS: Record<string, string> = {
  rescuerUsdc: "the reserve balance",
  rescuerAllowance: "the reserve's allowance to the Pool",
  healthFactor: "health factor",
  usdcDebt: "the USDC debt",
  totalDebtBase: "the debt",
  totalCollateralBase: "the collateral",
  usdcPriceBase: "the USDC price",
  liquidationThresholdBps: "the liquidation threshold",
};

/** The keeper's recorded reason, in words, for the reasons the site knows. Null for any other. */
export function plainReason(reason: string | null): string | null {
  if (!reason) return null;
  const disagreement = /^quorum_disagreement: (\w+) differs by more than (\d+) bps/.exec(reason);
  if (disagreement) {
    const field = FIELD_WORDS[disagreement[1] as string] ?? disagreement[1];
    return `Two RPCs disagreed on ${field} by more than ${Number(disagreement[2]) / 100}%, so the keeper did nothing.`;
  }
  if (reason.startsWith("quorum_stale")) return "The RPC reads were too old to act on, so the keeper did nothing.";
  if (reason.startsWith("quorum_too_few_rpcs")) return "Too few RPCs answered to act on, so the keeper did nothing.";
  return null;
}

function marksOf({ timestamps }: EvidenceRun): Marks {
  const from = timestamps.detected;
  const since = (at: number | null) => (from === null || at === null || at < from ? null : at - from);
  return { near: since(timestamps.nearIncluded), signed: since(timestamps.signed), sent: since(timestamps.broadcast), included: since(timestamps.included) };
}

const chainOf = (run: EvidenceRun) => (run.chainId === null ? "Unknown chain" : (CHAIN_NAMES[run.chainId] ?? `Chain ${run.chainId}`));

const toNumber = (value: string | null | undefined) => {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/** The landed run whose total is the median total, by the same nearest rank as every p50 here. */
export function medianRun(runs: EvidenceRun[]): EvidenceRun | null {
  const landed = runs.filter((run) => run.outcome === "success" && run.latencyMs !== null);
  const median = percentile(
    landed.map((run) => run.latencyMs as number),
    0.5,
  );
  if (median === null) return null;
  // Several runs can share the median. The newest is the one shown.
  return [...landed].sort((a, b) => b.id.localeCompare(a.id)).find((run) => run.latencyMs === median) ?? null;
}

function replayOf(run: EvidenceRun, runs: EvidenceRun[]): Replay | null {
  const marks = marksOf(run);
  const near = nearLink(run);
  const evm = evmLink(run);
  const healthBefore = toNumber(run.healthBefore);
  const healthAfter = toNumber(run.healthAfter);
  const amount = usdcAmount(run.amount);
  const detectedAt = run.timestamps.detected;
  if (marks.near === null || marks.signed === null || marks.sent === null || marks.included === null) return null;
  if (!near || !evm || healthBefore === null || healthAfter === null || !amount || detectedAt === null) return null;

  const trace = run.trace;
  const target = toNumber(trace?.target);
  const collateral = toNumber(trace?.collateralBase);
  const debt = toNumber(trace?.debtBase);
  const threshold = toNumber(trace?.thresholdBps);
  // The run before this one left health factor where the fall starts.
  const previous = runs.filter((other) => other.outcome === "success" && other.id < run.id).sort((a, b) => b.id.localeCompare(a.id))[0];
  const from = toNumber(previous?.healthAfter) ?? target;
  const before =
    collateral !== null && debt !== null && threshold !== null && from !== null && from > healthBefore && debt > 0
      ? { from, counted: (collateral / 1e8) * (threshold / 1e4), debtAt: debt / 1e8 }
      : null;

  return {
    id: run.id,
    detectedAt,
    chain: chainOf(run),
    network: run.network ?? "unknown",
    contract: run.nearContract,
    amount,
    healthBefore,
    healthAfter,
    trigger: toNumber(trace?.trigger),
    target,
    marks: { near: marks.near, signed: marks.signed, sent: marks.sent, included: marks.included },
    block: run.evmBlock,
    near: { href: near.href, label: "NEAR tx" },
    evm: { href: evm.href, label: `${chainOf(run).replace(" Sepolia", "")} tx` },
    before,
  };
}

function backtestOf(backtest: Backtest): BacktestFigures {
  const { cell } = backtest.headline;
  const honest = honestFigures(backtest);
  const rows = backtest.fair.map((row) => ({ share: row.reserveShare, positions: row.positions, levee: row.levee, upfront: row.repayAtArming, collateral: row.holdAsCollateral }));
  const misses = (Object.keys(MISS_NAMES) as MissReason[]).map((reason) => ({ reason, name: MISS_NAMES[reason], count: cell.reasons[reason] ?? 0 })).sort((a, b) => b.count - a.count);
  const capital = (chain: string) => `${chain.charAt(0).toUpperCase()}${chain.slice(1)}`;
  return {
    positions: cell.positions,
    trigger: cell.trigger,
    target: cell.target,
    delaySec: cell.delaySec,
    reserveShare: cell.reserveShare,
    windows: [...new Set(backtest.population.map((row) => row.window))].map(monthName),
    chains: [...new Set(backtest.population.map((row) => capital(row.chain)))],
    rows,
    upfrontNeverWorse: honest.repayAtArmingNeverWorse,
    collateralBeatsBoth: rows.filter((row) => row.collateral > row.levee && row.collateral > row.upfront).map((row) => row.share),
    saved: cell.saved,
    notSaved: cell.notSaved,
    armedBelow: honest.armedBelow,
    armedAbove: honest.armedAbove,
    savedArmedAbove: honest.savedArmedAbove,
    bothSurvive: honest.bothSurvive,
    collateralOnly: honest.collateralOnly,
    failedLaterInWindow: cell.failedLaterInWindow,
    misses,
    excluded: backtest.excludedPositions,
    topExclusions: backtest.exclusions.slice(0, 3).map(({ reason, positions }) => ({ reason, positions })),
    byWindow: backtest.byWindow.map((row) => ({ label: monthName(row.group), positions: row.positions, saved: row.saved })),
    liquidatedDebtUsd: backtest.population.reduce((total, row) => total + row.liquidatedDebtUsd, 0),
    reserveUsedOnSavedUsd: cell.reserveUsedOnSavedUsd,
    reserveHeldUsd: cell.reserveHeldUsd,
  };
}

function rehearsalOf({ label, run }: Rehearsal): RehearsalFigures {
  return { label, amount: usdcAmount(run.amount), healthBefore: run.healthBefore, healthAfter: run.healthAfter, latencyMs: run.latencyMs, near: nearLink(run) };
}

function signingOf(latency: MpcLatency): Signing {
  return {
    ...latency,
    links: latency.samples.map((sample) => (sample.nearTx && /^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(sample.nearTx) ? { href: `https://testnet.nearblocks.io/txns/${sample.nearTx}`, label: "NearBlocks" } : null)),
  };
}

export interface ProofInput {
  runs: EvidenceRun[];
  signing: MpcLatency | null;
  rehearsal: Rehearsal | null;
  backtest: Backtest | null;
}

export function buildProof({ runs, signing, rehearsal, backtest }: ProofInput): Proof {
  const sorted = [...runs].sort((a, b) => b.id.localeCompare(a.id));
  const median = medianRun(sorted);
  const { hops, overall } = latencyTable(sorted);
  const detected = sorted.flatMap((run) => {
    const at = run.timestamps.detected ?? idTime(run.id);
    return at === null ? [] : [at];
  });
  const triggers = [...new Set(sorted.flatMap((run) => (run.trace?.trigger ? [run.trace.trigger] : [])))];

  return {
    runs: sorted.map((run) => {
      const detectedAt = run.timestamps.detected ?? idTime(run.id);
      return {
        id: run.id,
        outcome: run.outcome,
        detectedAt,
        time: detectedAt === null ? null : new Date(detectedAt).toISOString().slice(11, 19),
        chain: chainOf(run),
        marks: marksOf(run),
        totalMs: run.latencyMs,
        amount: usdcAmount(run.amount),
        healthBefore: run.healthBefore,
        healthAfter: run.healthAfter,
        reason: run.failureReason,
        why: plainReason(run.failureReason),
        near: nearLink(run),
        evm: evmLink(run),
        evmBlock: run.evmBlock,
        replayed: run === median,
      };
    }),
    counts: tally(sorted),
    days: [...new Set(detected.sort((a, b) => a - b).map(day))].join(" and "),
    contracts: [...new Set(sorted.flatMap((run) => (run.nearContract ? [run.nearContract] : [])))],
    trigger: triggers.length === 1 ? toNumber(triggers[0]) : null,
    hops,
    overall,
    replay: median ? replayOf(median, sorted) : null,
    signing: signing ? signingOf(signing) : null,
    rehearsal: rehearsal ? rehearsalOf(rehearsal) : null,
    backtest: backtest ? backtestOf(backtest) : null,
  };
}

/** The hop with this id: near, mpc, send or evm. */
export function hop(proof: Proof, id: "near" | "mpc" | "send" | "evm"): LatencyRow | null {
  return proof.hops.find((row) => row.id === id) ?? null;
}

export const EMPTY_PROOF: Proof = buildProof({ runs: [], signing: null, rehearsal: null, backtest: null });
