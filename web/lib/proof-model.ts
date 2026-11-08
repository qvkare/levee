/**
 * Every figure the site states about Levee itself, worked out in one place: the run records, the
 * claims ledger, the signing test, the fork rehearsal and both backtests. Pages read the result
 * through PROOF in proof.ts, so no two pages can print a different number for the same thing. Pure.
 */
import { COLLATERAL_MISS_NAMES, headlineRow, type CollateralBacktest, type CollateralMiss } from "./backtest-collateral.ts";
import { MISS_NAMES, honestFigures, type Backtest, type MissReason } from "./backtest.ts";
import { KEY_DELETIONS, KEYLESS_RESCUE_NEAR_BLOCK, TOKENS, VERSIONS, type KeyDeletion } from "./contracts.ts";
import { CHAIN_NAMES, evmLink, latencyTable, median, nearLink, percentile, tally, type Claim, type EvidenceRun, type LatencyRow, type Mode, type MpcLatency, type Outcome, type Rehearsal, type Tally } from "./evidence.ts";

export type { Mode } from "./evidence.ts";

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

/** What a collateral run sold. */
export interface Sale {
  /** WETH, or a short address for a token the site does not know. */
  symbol: string;
  /** 0.003288 WETH. Null when nothing was sold. */
  sold: string | null;
  /** The keeper's cap on the sale, from a fresh quote plus its tolerance. */
  maxSold: string | null;
  /** How far under Aave's oracle the sale was, the pool fee included. */
  discountBps: number | null;
}

export interface ProofRun {
  id: string;
  outcome: Outcome;
  mode: Mode;
  /** Detection, in milliseconds since the epoch. */
  detectedAt: number | null;
  /** 19:27:38, UTC. */
  time: string | null;
  chain: string;
  /** The Levee contract the keeper called, and its version. */
  contract: string | null;
  version: string | null;
  marks: Marks;
  totalMs: number | null;
  /** 7.85 USDC. Null when nothing was repaid. */
  amount: string | null;
  healthBefore: string | null;
  healthAfter: string | null;
  sale: Sale | null;
  /** As the keeper recorded it. */
  reason: string | null;
  /** The same, in words, when the reason is one the site knows. */
  why: string | null;
  near: Link | null;
  evm: Link | null;
  evmBlock: number | null;
  /** The run the home page replays. */
  replayed: boolean;
  /** The claims ledger ties this run to both contract accounts having no keys. */
  keyless: boolean;
}

/** The run the home page replays. */
export interface Replay {
  id: string;
  mode: Mode;
  /** Why this run: the claims ledger ties it to the contracts having no keys, or it is the median run. */
  chosen: "keyless" | "median";
  detectedAt: number;
  chain: string;
  network: string;
  contract: string | null;
  version: string | null;
  amount: string;
  sale: Sale | null;
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

export interface Timing {
  hops: LatencyRow[];
  overall: LatencyRow;
}

/** Every figure about the runs of one mode. */
export interface ModeFigures {
  mode: Mode;
  counts: Tally;
  /** 7 Nov 2026. */
  days: string;
  /** The Levee contracts its runs called. */
  contracts: string[];
  /** v0.2 */
  versions: string[];
  /** The keeper's trigger and target, when every run of the mode used the same. */
  trigger: number | null;
  target: number | null;
  timing: Timing;
  /** The lowest and highest health factor its landed runs left. */
  landedHealth: { low: number; high: number } | null;
  /** The cheapest and dearest sale against the oracle, in bps, for collateral runs. */
  discount: { low: number; high: number } | null;
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

/** The contracts with no keys, and the rescue that landed after. */
export interface Keyless {
  claimId: string;
  claim: string;
  accounts: string[];
  deletions: KeyDeletion[];
  run: string;
  /** The NEAR block of that rescue call. */
  afterBlock: number;
}

/** One reserve size of the reserve-mode backtest. Counts of positions that survived, out of `positions`. */
export interface BacktestRow {
  share: number;
  positions: number;
  levee: number;
  /** The same USDC repaid at the start, with no keeper. */
  upfront: number;
  /** The same USDC held as Aave collateral, with no keeper. */
  collateral: number;
}

/** The reserve mode's backtest, over liquidated positions only. */
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

/** Collateral mode at one price bound, in one period. Dollars, over every member, liquidated or not. */
export interface BoundFigures {
  bps: number;
  saved: number;
  /** Saved because they were already below the trigger when armed, so the unwind ran at once. */
  savedArmedBelow: number;
  bonusAvoided: number;
  swapCost: number;
  /** Counting no sale better than the oracle. */
  swapCostNoBetter: number;
  gas: number;
  gasReverted: number;
  net: number;
  netNoBetter: number;
  /** With no gas on reverted unwinds. */
  netNoReverts: number;
  /** Members armed above the trigger: swap cost and gas each, and collateral sold as a share of theirs. */
  perMemberAbove: number;
  soldShareAbove: number;
  membersAbove: number;
  misses: Array<{ reason: CollateralMiss; name: string; count: number }>;
}

export interface PeriodFigures {
  key: string;
  /** 10 to 11 Oct 2025 */
  range: string;
  days: number;
  calm: boolean;
  members: number;
  liquidated: number;
  bonusAtRisk: number;
  bounds: BoundFigures[];
  /** The reserve at 30% of debt, counted as collateral mode is. */
  reserve: { share: number; saved: number; bonusAvoided: number };
  upfront: { share: number; saved: number; bonusAvoided: number };
}

/** Net by size of debt at arming, at one bound in one period. */
export interface SizeSplit {
  period: string;
  bps: number;
  /** Under this much debt is small. */
  threshold: number;
  smallNet: number;
  smallGas: number;
  largeNet: number;
}

/** The collateral backtest, the main mode's. */
export interface CollateralFigures {
  trigger: number;
  target: number;
  delaySec: number;
  /** Base first. */
  chains: string[];
  bounds: number[];
  periods: PeriodFigures[];
  sizes: SizeSplit[];
}

export interface Proof {
  /** Newest first, every outcome, both modes. */
  runs: ProofRun[];
  counts: Tally;
  /** The days the runs were made on: 7 and 8 Nov 2026. */
  days: string;
  modes: Record<Mode, ModeFigures>;
  /** The Levee contracts the runs called. */
  contracts: string[];
  replay: Replay | null;
  keyless: Keyless | null;
  /** The trigger the reading tool marks on a distance line: the backtest's, else the runs'. */
  readingTrigger: number | null;
  signing: Signing | null;
  rehearsal: RehearsalFigures | null;
  backtest: CollateralFigures | null;
  reserveBacktest: BacktestFigures | null;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 7 Nov 2026, in UTC. */
export function day(ms: number): string {
  const date = new Date(ms);
  return `${date.getUTCDate()} ${SHORT_MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** 7 and 8 Nov 2026, or each day in full when the months differ. */
export function dayList(times: number[]): string {
  const dates = [...new Set([...times].sort((a, b) => a - b).map(day))];
  if (dates.length < 2) return dates.join("");
  const tails = dates.map((date) => date.replace(/^\d+ /, ""));
  if (tails.every((tail) => tail === tails[0])) {
    const numbers = dates.map((date) => date.split(" ")[0]);
    return `${numbers.slice(0, -1).join(", ")} and ${numbers[numbers.length - 1]} ${tails[0]}`;
  }
  return `${dates.slice(0, -1).join(", ")} and ${dates[dates.length - 1]}`;
}

/** 2025-10 as October 2025. Anything else is left as it is. */
export function monthName(key: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  return match && month ? `${month} ${match[1]}` : key;
}

/** 2025-10-10 to 2025-10-11 as 10 to 11 Oct 2025, and 2025-12-03 to 2026-01-01 as 3 Dec 2025 to 1 Jan 2026. */
export function rangeName(label: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2}) to (\d{4})-(\d{2})-(\d{2})$/.exec(label);
  if (!match) return label;
  const [, y1, m1, d1, y2, m2, d2] = match as unknown as string[];
  const a = { day: Number(d1), month: SHORT_MONTHS[Number(m1) - 1], year: y1 };
  const b = { day: Number(d2), month: SHORT_MONTHS[Number(m2) - 1], year: y2 };
  if (a.year !== b.year) return `${a.day} ${a.month} ${a.year} to ${b.day} ${b.month} ${b.year}`;
  if (a.month !== b.month) return `${a.day} ${a.month} to ${b.day} ${b.month} ${b.year}`;
  return `${a.day} to ${b.day} ${b.month} ${b.year}`;
}

/** Run ids start with the detection time: 2026-11-07T19-27-38Z. */
function idTime(id: string): number | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z/.exec(id);
  return match ? Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`) : null;
}

/** USDC has 6 decimals and amounts are recorded in base units. To the nearest cent, as docs/SPEC.md prints them, with no float. */
export function usdcAmount(baseUnits: string | null): string | null {
  if (!baseUnits || !/^\d+$/.test(baseUnits) || /^0+$/.test(baseUnits)) return null;
  const cents = (BigInt(baseUnits) + 5000n) / 10000n;
  return `${(cents / 100n).toLocaleString("en-US")}.${(cents % 100n).toString().padStart(2, "0")} USDC`;
}

/** A token amount in base units, to six decimals and rounded down, with no float: 0.003288 WETH. */
export function tokenAmount(baseUnits: string | null, decimals: number, symbol: string): string | null {
  if (!baseUnits || !/^\d+$/.test(baseUnits) || /^0+$/.test(baseUnits)) return null;
  const padded = baseUnits.padStart(decimals + 1, "0");
  const whole = BigInt(padded.slice(0, -decimals)).toLocaleString("en-US");
  const shown = Math.min(6, decimals);
  return `${whole}.${padded.slice(-decimals).slice(0, shown)} ${symbol}`;
}

const tokenOf = (address: string | null) => (address ? (TOKENS[address.toLowerCase()] ?? null) : null);
const symbolOf = (address: string | null) => tokenOf(address)?.symbol ?? (address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "collateral");

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
export function plainReason(reason: string | null, symbol = "collateral"): string | null {
  if (!reason) return null;
  const disagreement = /^quorum_disagreement: (\w+) differs by more than (\d+) bps/.exec(reason);
  if (disagreement) {
    const field = FIELD_WORDS[disagreement[1] as string] ?? disagreement[1];
    return `Two RPCs disagreed on ${field} by more than ${Number(disagreement[2]) / 100}%, so the keeper did nothing.`;
  }
  if (reason.startsWith("quorum_stale")) return "The RPC reads were too old to act on, so the keeper did nothing.";
  if (reason.startsWith("quorum_too_few_rpcs")) return "Too few RPCs answered to act on, so the keeper did nothing.";
  const bound = /^quote_over_slippage_bound: the pool asks (\d+) for \d+ USDC units, the helper allows (\d+)/.exec(reason);
  if (bound) {
    const over = Number(bound[1]) / Number(bound[2]) - 1;
    return `The pool asked ${(over * 100).toFixed(2)}% more ${symbol} than the borrower’s price bound allows, so the keeper refused before asking NEAR, and nothing was sent.`;
  }
  if (reason.startsWith("quote_over_slippage_bound")) return "The pool’s quote was past the borrower’s price bound, so the keeper refused before asking NEAR, and nothing was sent.";
  if (reason.startsWith("quote_unavailable")) return "Fewer than two endpoints could quote the sale, so the keeper sent nothing.";
  if (reason.startsWith("quote_disagreement")) return "The endpoints’ quotes for the sale differed by more than 0.5%, so the keeper sent nothing.";
  if (reason.startsWith("ltv_zero_collateral")) return "Another collateral in the account has an LTV of 0, so Aave would refuse the sale. The keeper sent nothing.";
  if (reason.startsWith("above_trigger")) return "Health factor was back above the trigger when the unwind landed, so the helper refused it. Only gas was spent.";
  if (reason.startsWith("helper_config_mismatch")) return "The helper’s terms differ from the keeper’s, so the keeper stopped.";
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

function saleOf(run: EvidenceRun): Sale | null {
  if (run.mode !== "collateral") return null;
  const token = tokenOf(run.collateral);
  const symbol = symbolOf(run.collateral);
  const decimals = token?.decimals ?? 18;
  return { symbol, sold: tokenAmount(run.sold, decimals, symbol), maxSold: tokenAmount(run.maxSold, decimals, symbol), discountBps: run.swap?.discountBps ?? null };
}

/** The landed run whose total is the median total, by nearest rank, so it is always a real run. */
export function medianRun(runs: EvidenceRun[]): EvidenceRun | null {
  const landed = runs.filter((run) => run.outcome === "success" && run.latencyMs !== null);
  const middle = percentile(
    landed.map((run) => run.latencyMs as number),
    0.5,
  );
  if (middle === null) return null;
  // Several runs can share the median. The newest is the one shown.
  return [...landed].sort((a, b) => b.id.localeCompare(a.id)).find((run) => run.latencyMs === middle) ?? null;
}

/** The claim that both contract accounts have no keys, when it names a landed run on file. */
export function keylessClaim(claims: Claim[], runs: EvidenceRun[]): Claim | null {
  return claims.find((claim) => claim.noAccessKeys.length > 0 && claim.run !== null && runs.some((run) => run.id === claim.run && run.outcome === "success" && run.latencyMs !== null)) ?? null;
}

/** The run the home page replays: the one the no-keys claim names, else the median collateral run, else the median run. */
export function featuredRun(runs: EvidenceRun[], claims: Claim[]): { run: EvidenceRun; chosen: Replay["chosen"] } | null {
  const claim = keylessClaim(claims, runs);
  const named = claim ? runs.find((run) => run.id === claim.run) : undefined;
  if (named) return { run: named, chosen: "keyless" };
  const fallback = medianRun(runs.filter((run) => run.mode === "collateral")) ?? medianRun(runs);
  return fallback ? { run: fallback, chosen: "median" } : null;
}

function replayOf(run: EvidenceRun, runs: EvidenceRun[], chosen: Replay["chosen"]): Replay | null {
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
  // The run before this one, on the same contract, left health factor where the fall starts.
  const previous = runs.filter((other) => other.outcome === "success" && other.id < run.id && other.nearContract === run.nearContract).sort((a, b) => b.id.localeCompare(a.id))[0];
  const from = toNumber(previous?.healthAfter) ?? target;
  const before =
    collateral !== null && debt !== null && threshold !== null && from !== null && from > healthBefore && debt > 0
      ? { from, counted: (collateral / 1e8) * (threshold / 1e4), debtAt: debt / 1e8 }
      : null;

  return {
    id: run.id,
    mode: run.mode,
    chosen,
    detectedAt,
    chain: chainOf(run),
    network: run.network ?? "unknown",
    contract: run.nearContract,
    version: run.nearContract ? (VERSIONS[run.nearContract] ?? null) : null,
    amount,
    sale: saleOf(run),
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

const common = (values: Array<string | null | undefined>) => {
  const set = [...new Set(values.filter((value): value is string => typeof value === "string"))];
  return set.length === 1 ? toNumber(set[0]) : null;
};

const range = (values: number[]) => (values.length === 0 ? null : { low: Math.min(...values), high: Math.max(...values) });

function detectedOf(run: EvidenceRun): number | null {
  return run.timestamps.detected ?? idTime(run.id);
}

function modeOf(mode: Mode, runs: EvidenceRun[]): ModeFigures {
  const mine = runs.filter((run) => run.mode === mode);
  const landed = mine.filter((run) => run.outcome === "success");
  const contracts = [...new Set(mine.flatMap((run) => (run.nearContract ? [run.nearContract] : [])))];
  return {
    mode,
    counts: tally(mine),
    days: dayList(mine.flatMap((run) => {
      const at = detectedOf(run);
      return at === null ? [] : [at];
    })),
    contracts,
    versions: contracts.flatMap((contract) => (VERSIONS[contract] ? [VERSIONS[contract] as string] : [])),
    trigger: common(mine.map((run) => run.trace?.trigger)),
    target: common(mine.map((run) => run.trace?.target)),
    timing: latencyTable(mine),
    landedHealth: range(landed.flatMap((run) => {
      const value = toNumber(run.healthAfter);
      return value === null ? [] : [value];
    })),
    discount: mode === "collateral" ? range(landed.flatMap((run) => (run.swap?.discountBps == null ? [] : [run.swap.discountBps]))) : null,
  };
}

function reserveBacktestOf(backtest: Backtest): BacktestFigures {
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
    // Base first, as everywhere else on the site.
    chains: [...new Set(backtest.population.map((row) => capital(row.chain)))].sort((a, b) => (a === "Base" ? -1 : b === "Base" ? 1 : a.localeCompare(b))),
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

/** The share of debt the backtest's reserve and upfront comparisons hold, as collateral.md states it. */
const COMPARISON_SHARE = 0.3;
/** Debt at arming under this is a small position, in the size split. */
const SMALL_DEBT = 10_000;

function collateralBacktestOf(backtest: CollateralBacktest): CollateralFigures | null {
  const bounds = [...backtest.rules.slippageBps].sort((a, b) => a - b);
  const periods: PeriodFigures[] = [];
  for (const { period, label, days } of backtest.periods) {
    const comparison = backtest.comparison.find((row) => row.period === period && row.trigger === backtest.base.trigger);
    const cells = bounds.map((bps) => headlineRow(backtest, period, bps));
    if (!comparison || cells.some((cell) => cell === null)) continue;
    periods.push({
      key: period,
      range: rangeName(label),
      days,
      calm: period === "calm",
      members: comparison.check.members,
      liquidated: comparison.liquidated,
      bonusAtRisk: comparison.bonusAtRisk,
      bounds: cells.map((cell, index) => {
        const row = cell as NonNullable<typeof cell>;
        const membersAbove = row.members - row.armedBelow;
        return {
          bps: bounds[index] as number,
          saved: row.saved,
          savedArmedBelow: row.savedArmedBelow,
          bonusAvoided: row.bonusAvoided,
          swapCost: row.swapCost,
          swapCostNoBetter: row.swapCostPositive,
          gas: row.gas,
          gasReverted: row.gasReverted,
          net: row.net,
          netNoBetter: row.net - (row.swapCostPositive - row.swapCost),
          netNoReverts: row.net + row.gasReverted,
          perMemberAbove: membersAbove > 0 ? (row.swapCost - row.swapCostArmedBelow + row.gas - row.gasArmedBelow) / membersAbove : 0,
          soldShareAbove: row.collateralArmedAbove > 0 ? (row.sold - row.soldArmedBelow) / row.collateralArmedAbove : 0,
          membersAbove,
          misses: (Object.keys(COLLATERAL_MISS_NAMES) as CollateralMiss[]).map((reason) => ({ reason, name: COLLATERAL_MISS_NAMES[reason], count: row.reasons[reason] ?? 0 })).filter((miss) => miss.count > 0).sort((a, b) => b.count - a.count),
        };
      }),
      reserve: { share: COMPARISON_SHARE, saved: comparison.reserve.savedCapped ?? comparison.reserve.saved, bonusAvoided: comparison.reserve.bonusAvoidedCapped ?? comparison.reserve.bonusAvoided },
      upfront: { share: COMPARISON_SHARE, saved: comparison.upfront.saved, bonusAvoided: comparison.upfront.bonusAvoided },
    });
  }
  if (periods.length === 0) return null;
  // Buckets are named "3. $1k to $10k", and the first three are under $10k of debt.
  const small = (bucket: string) => /under \$100$|\$100 to \$1k|\$1k to \$10k/.test(bucket);
  const sizes: SizeSplit[] = periods.flatMap(({ key }) =>
    bounds.map((bps) => {
      const rows = backtest.bySize.filter((row) => row.period === key && row.slippageBps === bps);
      const sum = (pick: (row: (typeof rows)[number]) => number, inSmall: boolean) => rows.filter((row) => small(row.bucket) === inSmall).reduce((total, row) => total + pick(row), 0);
      return { period: key, bps, threshold: SMALL_DEBT, smallNet: sum((row) => row.net, true), smallGas: sum((row) => row.gas, true), largeNet: sum((row) => row.net, false) };
    }),
  );
  const chains = [...new Set(backtest.population.map((row) => row.chain).filter((chain) => chain !== "all"))]
    .map((chain) => `${chain.charAt(0).toUpperCase()}${chain.slice(1)}`)
    .sort((a, b) => (a === "Base" ? -1 : b === "Base" ? 1 : a.localeCompare(b)));
  return { trigger: backtest.base.trigger, target: backtest.base.target, delaySec: backtest.base.delaySec, chains, bounds, periods, sizes };
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
  claims?: Claim[];
  signing: MpcLatency | null;
  rehearsal: Rehearsal | null;
  backtest?: CollateralBacktest | null;
  reserveBacktest: Backtest | null;
}

export function buildProof({ runs, claims = [], signing, rehearsal, backtest = null, reserveBacktest }: ProofInput): Proof {
  const sorted = [...runs].sort((a, b) => b.id.localeCompare(a.id));
  const featured = featuredRun(sorted, claims);
  const claim = keylessClaim(claims, sorted);
  const detected = sorted.flatMap((run) => {
    const at = detectedOf(run);
    return at === null ? [] : [at];
  });
  const modes = { collateral: modeOf("collateral", sorted), reserve: modeOf("reserve", sorted) };
  const collateral = backtest ? collateralBacktestOf(backtest) : null;

  return {
    runs: sorted.map((run) => {
      const detectedAt = detectedOf(run);
      const sale = saleOf(run);
      return {
        id: run.id,
        outcome: run.outcome,
        mode: run.mode,
        detectedAt,
        time: detectedAt === null ? null : new Date(detectedAt).toISOString().slice(11, 19),
        chain: chainOf(run),
        contract: run.nearContract,
        version: run.nearContract ? (VERSIONS[run.nearContract] ?? null) : null,
        marks: marksOf(run),
        totalMs: run.latencyMs,
        amount: usdcAmount(run.amount),
        healthBefore: run.healthBefore,
        healthAfter: run.healthAfter,
        sale,
        reason: run.failureReason,
        why: plainReason(run.failureReason, sale?.symbol),
        near: nearLink(run),
        evm: evmLink(run),
        evmBlock: run.evmBlock,
        replayed: run === featured?.run,
        keyless: claim !== null && claim.run === run.id,
      };
    }),
    counts: tally(sorted),
    days: dayList(detected),
    modes,
    contracts: [...new Set(sorted.flatMap((run) => (run.nearContract ? [run.nearContract] : [])))],
    replay: featured ? replayOf(featured.run, sorted, featured.chosen) : null,
    keyless: claim && claim.run ? { claimId: claim.id, claim: claim.claim, accounts: claim.noAccessKeys, deletions: KEY_DELETIONS.filter((deletion) => claim.noAccessKeys.includes(deletion.account)), run: claim.run, afterBlock: KEYLESS_RESCUE_NEAR_BLOCK } : null,
    readingTrigger: collateral?.trigger ?? modes.collateral.trigger ?? modes.reserve.trigger,
    signing: signing ? signingOf(signing) : null,
    rehearsal: rehearsal ? rehearsalOf(rehearsal) : null,
    backtest: collateral,
    reserveBacktest: reserveBacktest ? reserveBacktestOf(reserveBacktest) : null,
  };
}

/** The hop with this id, in one mode: near, mpc, send or evm. Collateral, the main mode, unless asked. */
export function hop(proof: Proof, id: "near" | "mpc" | "send" | "evm", mode: Mode = "collateral"): LatencyRow | null {
  return proof.modes[mode].timing.hops.find((row) => row.id === id) ?? null;
}

/** Detection to inclusion, in one mode. */
export function overall(proof: Proof, mode: Mode = "collateral"): LatencyRow {
  return proof.modes[mode].timing.overall;
}

export { median };

export const EMPTY_PROOF: Proof = buildProof({ runs: [], signing: null, rehearsal: null, reserveBacktest: null });
