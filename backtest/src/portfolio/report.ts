// The population, shared-reserve, calm-period and carry results. Reads committed files only.
import { join } from 'node:path';
import { CALM_ID, WINDOWS, type ChainKey } from '../config.ts';
import { decodeObserved, readPositions, readPrices, type DerivedPosition, type WindowPrices } from '../data.ts';
import type { CalmFile, DailyRow } from '../fetch/daily.ts';
import type { MarketSnapshot } from '../fetch/reserves.ts';
import { PriceBook } from '../frozen.ts';
import { COOLDOWN_SEC, GRID } from '../grid.ts';
import { DERIVED_DIR, existsSync, readJson } from '../paths.ts';
import { firstEpisodeBonus, prepare, SIZE_BUCKETS } from '../report/aggregate.ts';
import { healthFactor, type Params, type PositionPath } from '../sim/simulate.ts';
import { simulateShared, simulateTracked, survivesUpfront, trackedArming, type TrackedPath } from '../sim/tracked.ts';
import { readCalmPrices, readGz, readPopulation, SAMPLE_FILE, type PopulationFile, type SampleFile } from './data.ts';
import { PeriodModel } from './model.ts';
import { mulberry32 } from './random.ts';

/** The cell these parts quote, with the headline's target and delay. */
export const BASE = { trigger: 1.2, target: 1.5, reserveShare: 0.3, delaySec: 60 } as const;
/** Sharing across chains needs the off-venue reserve, whose route time is not measured. */
export const SHARED_SLOW_DELAY_SEC = 300;
export const PAIR_SEED = 20261108;
/** Below this many real pairs holding a liquidated position in a window, synthetic pairs are added. */
export const REAL_PAIRS_NEEDED = 50;
/** Validation compares reads with at least this much debt. */
const MIN_DEBT_USD = 1;

const CHAINS_ORDER: ChainKey[] = ['arbitrum', 'base'];
/** Code-point order, so a draw does not depend on the machine's locale. */
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const PERIODS = [...WINDOWS.map((w) => w.id), CALM_ID];
const params = (trigger: number, reserveShare: number, delaySec: number = BASE.delaySec): Params => ({ trigger, target: BASE.target, reserveShare, delaySec, cooldownSec: COOLDOWN_SEC });
const runIndex = (trigger: number, reserveShare: number): number => {
  const i = RUNS.findIndex(([t, r]) => t === trigger && r === reserveShare);
  if (i < 0) throw new Error(`no run for T ${trigger} R ${reserveShare}`);
  return i;
};
const reserveIndex = (reserveShare: number): number => GRID.reserveShares.indexOf(reserveShare as (typeof GRID.reserveShares)[number]);
/** Parameter sets run for every member: every trigger at R 30%, every R at T 1.20. */
const RUNS: Array<[number, number]> = [
  ...GRID.triggers.map((t): [number, number] => [t, BASE.reserveShare]),
  ...GRID.reserveShares.filter((r) => r !== BASE.reserveShare).map((r): [number, number] => [BASE.trigger, r]),
];

export interface MemberRecord {
  chain: ChainKey;
  period: string;
  member: number;
  user: string;
  start: boolean;
  headline: boolean;
  liquidated: boolean;
  armDebt: number;
  armHf: number;
  /** Lowest HF from arming to the real liquidation, or to the period end. */
  minHf: number;
  bonusUsd: number;
  /** Per entry of RUNS: reserve sent and whether the position was saved. */
  levee: Array<{ fired: number; saved: boolean }>;
  /** Per entry of GRID.reserveShares: survives with R × debt repaid at arming. Liquidated members only. */
  upfront: boolean[];
  /** Per entry of GRID.reserveShares, at T 1.20: saved with a landed repay capped at the USDC debt on the path. */
  capped: boolean[];
}

export interface Context {
  models: Map<string, PeriodModel>;
  /** Headline positions of the period being built, by id, and its price books. */
  headline: Map<string, DerivedPosition>;
  books: Map<ChainKey, PriceBook>;
}

export const toTracked = (path: PositionPath): TrackedPath => ({
  points: path.points.map((p) => ({ ...p, usdcDebt: path.usdcShare * p.debt })),
  liquidation: { block: path.liquidationBlock, t: path.liquidationTime },
});

function marketsOf(): MarketSnapshot[] {
  return [...readJson<MarketSnapshot[]>(join(DERIVED_DIR, 'markets.json')), ...readJson<MarketSnapshot[]>(join(DERIVED_DIR, 'portfolio', 'markets-calm.json'))];
}

/** A headline position's committed path, as a tracked path. Built on demand, not kept. */
function headlinePath(ctx: Context, position: DerivedPosition): TrackedPath {
  const frozen = ctx.books.get(position.chain)!.frozenPath(position.portfolio!, position.liquidationBlock, position.liquidationTime);
  return toTracked(prepare(position, 0.78, frozen).path);
}

/** The member's path: the headline path if it has one, else the rebuilt path. */
function pathOf(ctx: Context, chain: ChainKey, period: string, member: number): TrackedPath | null {
  const model = ctx.models.get(`${chain}:${period}`)!;
  const headline = ctx.headline.get(`${chain}:${period}:${model.members[member]}`);
  if (headline) return headlinePath(ctx, headline);
  return model.build(member)?.path ?? null;
}

export function memberRecords(ctx: Context, chain: ChainKey, period: string): MemberRecord[] {
  const model = ctx.models.get(`${chain}:${period}`)!;
  const out: MemberRecord[] = [];
  for (let member = 0; member < model.members.length; member++) {
    const user = model.members[member]!;
    const headline = ctx.headline.get(`${chain}:${period}:${user}`);
    let path: TrackedPath;
    let armDebt: number;
    let armHf: number;
    let minHf: number;
    let bonusUsd: number;
    if (headline) {
      path = headlinePath(ctx, headline);
      const arming = trackedArming(path);
      armDebt = arming.debt;
      armHf = healthFactor(arming.capacity, arming.debt);
      minHf = Infinity;
      for (const p of path.points) if (p.block < headline.liquidationBlock && p.t >= arming.t) minHf = Math.min(minHf, healthFactor(p.capacity, p.debt));
      bonusUsd = firstEpisodeBonus(headline);
    } else {
      const built = model.build(member);
      if (!built) continue;
      path = built.path;
      armDebt = built.armDebt;
      armHf = built.armHf;
      minHf = built.minHf;
      bonusUsd = built.bonusUsd;
    }
    const liquidated = path.liquidation !== null;
    const record: MemberRecord = {
      chain,
      period,
      member,
      user,
      start: member < model.file.census.startMembers,
      headline: headline !== undefined,
      liquidated,
      armDebt,
      armHf,
      minHf,
      bonusUsd,
      levee: [],
      upfront: [],
      capped: [],
    };
    for (const [trigger, reserveShare] of RUNS) {
      if (!liquidated && armHf >= trigger && minHf >= trigger) {
        record.levee.push({ fired: 0, saved: true });
        continue;
      }
      const outcome = simulateTracked(path, params(trigger, reserveShare));
      record.levee.push({ fired: outcome.fired, saved: outcome.saved });
    }
    for (const r of GRID.reserveShares) {
      record.upfront.push(!liquidated || survivesUpfront(path, r * armDebt));
      record.capped.push(!liquidated || simulateTracked(path, params(BASE.trigger, r), { capLanded: true }).saved);
    }
    out.push(record);
  }
  return out;
}

// ---------- Population ----------

export interface PopulationRow {
  chain: ChainKey | 'all';
  period: string;
  trigger: number;
  reserveShare: number;
  members: number;
  armedBelow: number;
  /** Armed above T, then HF below T at some point. */
  crossed: number;
  /** Liquidated in the period, with no Levee. */
  liquidated: number;
  /** Of `crossed`: liquidated. */
  crossedLiquidated: number;
  /** Of `crossed`: not liquidated, and HF below 1 on the path. */
  crossedBelow1: number;
  /** Of `crossed`: not liquidated, HF never below 1. */
  falseAlarms: number;
  reserveHeld: number;
  drawn: number;
  /** Drawn by members not liquidated in reality: they survived anyway. */
  drawnBySurvivors: number;
  drawnArmedBelow: number;
  /** Reserve held by members armed below T. */
  reserveHeldArmedBelow: number;
  bonusAtRisk: number;
  savedLevee: number;
  /** Sensitivity, T 1.20 only: a landed repay counts only up to the USDC debt on the path. */
  savedLeveeCapped: number;
  savedUpfront: number;
  bonusAvoidedLevee: number;
  bonusAvoidedLeveeCapped: number;
  bonusAvoidedUpfront: number;
  debtAtArming: number;
}

export function populationRow(records: MemberRecord[], chain: ChainKey | 'all', period: string, trigger: number, reserveShare: number): PopulationRow {
  const row: PopulationRow = {
    chain,
    period,
    trigger,
    reserveShare,
    members: 0,
    armedBelow: 0,
    crossed: 0,
    liquidated: 0,
    crossedLiquidated: 0,
    crossedBelow1: 0,
    falseAlarms: 0,
    reserveHeld: 0,
    drawn: 0,
    drawnBySurvivors: 0,
    drawnArmedBelow: 0,
    reserveHeldArmedBelow: 0,
    bonusAtRisk: 0,
    savedLevee: 0,
    savedLeveeCapped: 0,
    savedUpfront: 0,
    bonusAvoidedLevee: 0,
    bonusAvoidedLeveeCapped: 0,
    bonusAvoidedUpfront: 0,
    debtAtArming: 0,
  };
  for (const r of records) {
    const run = r.levee[runIndex(trigger, reserveShare)]!;
    row.members++;
    row.debtAtArming += r.armDebt;
    row.reserveHeld += reserveShare * r.armDebt;
    row.drawn += run.fired;
    if (!r.liquidated) row.drawnBySurvivors += run.fired;
    const below = r.armHf < trigger;
    if (below) {
      row.armedBelow++;
      row.drawnArmedBelow += run.fired;
      row.reserveHeldArmedBelow += reserveShare * r.armDebt;
    } else if (r.liquidated || r.minHf < trigger) {
      row.crossed++;
      if (r.liquidated) row.crossedLiquidated++;
      else if (r.minHf < 1) row.crossedBelow1++;
      else row.falseAlarms++;
    }
    if (r.liquidated) {
      row.liquidated++;
      row.bonusAtRisk += r.bonusUsd;
      if (run.saved) {
        row.savedLevee++;
        row.bonusAvoidedLevee += r.bonusUsd;
      }
      if (trigger === BASE.trigger && r.capped[reserveIndex(reserveShare)]) {
        row.savedLeveeCapped++;
        row.bonusAvoidedLeveeCapped += r.bonusUsd;
      }
      if (r.upfront[reserveIndex(reserveShare)]) {
        row.savedUpfront++;
        row.bonusAvoidedUpfront += r.bonusUsd;
      }
    }
  }
  for (const k of ['reserveHeld', 'drawn', 'drawnBySurvivors', 'drawnArmedBelow', 'reserveHeldArmedBelow', 'bonusAtRisk', 'bonusAvoidedLevee', 'bonusAvoidedLeveeCapped', 'bonusAvoidedUpfront', 'debtAtArming'] as const) row[k] = Math.round(row[k]);
  return row;
}

export interface SizeRow {
  period: string;
  bucket: string;
  members: number;
  armedBelow: number;
  crossed: number;
  liquidated: number;
  falseAlarms: number;
  crossedBelow1: number;
  reserveHeld: number;
  drawn: number;
  drawnBySurvivors: number;
}

function sizeRows(records: MemberRecord[], period: string): SizeRow[] {
  return SIZE_BUCKETS.map((bucket, i) => {
    const row = populationRow(
      records.filter((r) => r.armDebt >= bucket.min && r.armDebt < bucket.max),
      'all',
      period,
      BASE.trigger,
      BASE.reserveShare,
    );
    return {
      period,
      bucket: `${i + 1}. ${bucket.label}`,
      members: row.members,
      armedBelow: row.armedBelow,
      crossed: row.crossed,
      liquidated: row.liquidated,
      falseAlarms: row.falseAlarms,
      crossedBelow1: row.crossedBelow1,
      reserveHeld: row.reserveHeld,
      drawn: row.drawn,
      drawnBySurvivors: row.drawnBySurvivors,
    };
  });
}

// ---------- Pairs ----------

export interface PairSetRow {
  period: string;
  set: 'real' | 'synthetic, independent' | 'synthetic, both liquidated';
  reserveShare: number;
  pairs: number;
  pairsWithLiquidation: number;
  pairsBothLiquidated: number;
  liquidatedPositions: number;
  /** Positions saved out of 2 × pairs. A position not liquidated in reality counts as saved. */
  saved: { shared: number; sharedSlow: number; upfront: number; separate: number };
  /** Of the liquidated positions. */
  savedLiquidated: { shared: number; sharedSlow: number; upfront: number; separate: number };
  bothSaved: { shared: number; sharedSlow: number; upfront: number; separate: number };
  bonusAtRisk: number;
  bonusAvoided: { shared: number; sharedSlow: number; upfront: number; separate: number };
  budget: number;
  /** Reserve sent from the shared budget to a position that was not liquidated in reality. */
  sharedDrawnBySurvivors: number;
  sharedDrawn: number;
  /** Anchors with no partner in the debt range. */
  skippedAnchors: number;
}

interface Pair {
  a: MemberRecord;
  b: MemberRecord;
}

function evaluatePairs(ctx: Context, pairs: Pair[], period: string, set: PairSetRow['set'], skippedAnchors: number): PairSetRow[] {
  const zero = (): { shared: number; sharedSlow: number; upfront: number; separate: number } => ({ shared: 0, sharedSlow: 0, upfront: 0, separate: 0 });
  const rows: PairSetRow[] = GRID.reserveShares.map((reserveShare) => ({
    period,
    set,
    reserveShare,
    pairs: pairs.length,
    pairsWithLiquidation: 0,
    pairsBothLiquidated: 0,
    liquidatedPositions: 0,
    saved: zero(),
    savedLiquidated: zero(),
    bothSaved: zero(),
    bonusAtRisk: 0,
    bonusAvoided: zero(),
    budget: 0,
    sharedDrawnBySurvivors: 0,
    sharedDrawn: 0,
    skippedAnchors,
  }));
  const kinds = ['shared', 'sharedSlow', 'upfront', 'separate'] as const;
  // One pair at a time, paths built once and dropped, so memory stays flat.
  for (const { a, b } of pairs) {
    const members = [a, b];
    const liquidatedCount = members.filter((m) => m.liquidated).length;
    const quiet = liquidatedCount === 0 && members.every((m) => m.armHf >= BASE.trigger && m.minHf >= BASE.trigger);
    const both = quiet ? null : [pathOf(ctx, a.chain, a.period, a.member)!, pathOf(ctx, b.chain, b.period, b.member)!];
    for (const row of rows) {
      const { reserveShare } = row;
      if (liquidatedCount > 0) row.pairsWithLiquidation++;
      if (liquidatedCount === 2) row.pairsBothLiquidated++;
      const budget = reserveShare * (a.armDebt + b.armDebt);
      row.budget += budget;
      const outcomes: Record<(typeof kinds)[number], boolean[]> = { shared: [true, true], sharedSlow: [true, true], upfront: [true, true], separate: [true, true] };
      if (both) {
        const shared = simulateShared(both, budget, params(BASE.trigger, reserveShare));
        shared.forEach((o, i) => {
          row.sharedDrawn += o.fired;
          if (!members[i]!.liquidated) row.sharedDrawnBySurvivors += o.fired;
        });
        if (liquidatedCount > 0) {
          outcomes.shared = shared.map((o) => o.saved);
          outcomes.sharedSlow = simulateShared(both, budget, params(BASE.trigger, reserveShare, SHARED_SLOW_DELAY_SEC)).map((o) => o.saved);
          outcomes.upfront = members.map((m) => m.upfront[reserveIndex(reserveShare)]!);
          outcomes.separate = members.map((m) => m.levee[runIndex(BASE.trigger, reserveShare)]!.saved);
        }
      }
      members.forEach((m, i) => {
        if (m.liquidated) {
          row.liquidatedPositions++;
          row.bonusAtRisk += m.bonusUsd;
        }
        for (const k of kinds) {
          if (!outcomes[k][i]) continue;
          row.saved[k]++;
          if (m.liquidated) {
            row.savedLiquidated[k]++;
            row.bonusAvoided[k] += m.bonusUsd;
          }
        }
      });
      for (const k of kinds) if (outcomes[k][0] && outcomes[k][1]) row.bothSaved[k]++;
    }
  }
  for (const row of rows) {
    for (const k of kinds) row.bonusAvoided[k] = Math.round(row.bonusAvoided[k]);
    row.bonusAtRisk = Math.round(row.bonusAtRisk);
    row.budget = Math.round(row.budget);
    row.sharedDrawn = Math.round(row.sharedDrawn);
    row.sharedDrawnBySurvivors = Math.round(row.sharedDrawnBySurvivors);
  }
  return rows;
}

export interface RealPairCount {
  period: string;
  pairs: number;
  withLiquidation: number;
  bothLiquidated: number;
  syntheticAdded: boolean;
}

/** Synthetic partners: README rule. One generator per window and version, seeded with PAIR_SEED. */
function syntheticPairs(records: MemberRecord[], period: string, bothLiquidated: boolean): { pairs: Pair[]; skipped: number } {
  const random = mulberry32(PAIR_SEED);
  const inPeriod = records.filter((r) => r.period === period);
  const anchors = inPeriod.filter((r) => r.headline).sort((x, y) => byText(`${x.chain}:${x.period}:${x.user}`, `${y.chain}:${y.period}:${y.user}`));
  const pool = new Map<ChainKey, MemberRecord[]>();
  for (const chain of CHAINS_ORDER) {
    pool.set(
      chain,
      inPeriod.filter((r) => r.chain === chain && (!bothLiquidated || r.headline)).sort((x, y) => byText(x.user, y.user)),
    );
  }
  const pairs: Pair[] = [];
  let skipped = 0;
  for (const anchor of anchors) {
    const other = anchor.chain === 'base' ? 'arbitrum' : 'base';
    const candidates = pool.get(other)!.filter((r) => r.armDebt >= anchor.armDebt / 2 && r.armDebt <= anchor.armDebt * 2 && r.user !== anchor.user);
    if (candidates.length === 0) {
      skipped++;
      continue;
    }
    pairs.push({ a: anchor, b: candidates[Math.floor(random() * candidates.length)]! });
  }
  return { pairs, skipped };
}

// ---------- Carry ----------

export interface CarryRow {
  chain: ChainKey;
  span: string;
  days: number;
  borrowApr: number;
  supplyApr: number;
  /** Per $1,000 of reserve per year: idle, against an upfront repay. */
  idlePer1000: number;
  /** Hypothetical, not in the spec: the reserve earns the USDC supply APR. */
  earningPer1000: number;
}

function timeWeighted(t: number[], values: number[]): number {
  let area = 0;
  let span = 0;
  for (let i = 1; i < t.length; i++) {
    const dt = t[i]! - t[i - 1]!;
    area += ((values[i]! + values[i - 1]!) / 2) * dt;
    span += dt;
  }
  return span > 0 ? area / span : values[0] ?? NaN;
}

function carryRow(chain: ChainKey, span: string, t: number[], borrow: number[], supply: number[]): CarryRow {
  const borrowApr = timeWeighted(t, borrow);
  const supplyApr = timeWeighted(t, supply);
  return {
    chain,
    span,
    days: Math.round((t[t.length - 1]! - t[0]!) / 86_400),
    borrowApr,
    supplyApr,
    idlePer1000: 1000 * borrowApr,
    earningPer1000: 1000 * (borrowApr - supplyApr),
  };
}

export interface BreakEvenRow {
  period: string;
  chain: ChainKey | 'all';
  reserveShare: number;
  reserveHeld: number;
  bonusAvoidedLevee: number;
  bonusAvoidedLeveeCapped: number;
  bonusAvoidedUpfront: number;
  /** Bonus avoided per dollar of reserve held, in this crash. */
  perDollarLevee: number;
  perDollarUpfront: number;
  /** A year of carry per dollar: idle, and the hypothetical earning case. */
  carryIdle: number;
  carryEarning: number;
  /** Crashes like this one a year for Levee's bonus avoided to pay a year of carry. */
  crashesToPayIdle: number;
  crashesToPayEarning: number;
}

// ---------- Validation ----------

export interface ErrorStats {
  n: number;
  median: number;
  p95: number;
  p99: number;
  max: number;
  within05: number;
}

function stats(errors: number[]): ErrorStats {
  const sorted = [...errors].sort((a, b) => a - b);
  const q = (x: number): number => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(x * sorted.length))]! : NaN);
  return { n: sorted.length, median: q(0.5), p95: q(0.95), p99: q(0.99), max: sorted[sorted.length - 1] ?? NaN, within05: sorted.filter((e) => e <= 0.005).length / Math.max(1, sorted.length) };
}

export interface ValidationRow {
  chain: ChainKey;
  period: string;
  candidates: number;
  startMembers: number;
  newcomers: number;
  totalSupplyGap: number;
  /** Reads with at least $1 of debt. Below that, Aave's 8-decimal base currency rounds a dust position's HF. */
  readback: ErrorStats;
  readbackAll: ErrorStats;
  sampleRandom: ErrorStats;
  sampleNear: ErrorStats;
  /** Share of sampled reads where rebuilt and direct HF fall on the same side of each trigger. */
  sampleAgreement: Record<string, number>;
  headline: ErrorStats | null;
}

function validation(ctx: Context, sample: SampleFile | null, positions: DerivedPosition[], period: string): ValidationRow[] {
  const rows: ValidationRow[] = [];
  {
    for (const chain of CHAINS_ORDER) {
      const model = ctx.models.get(`${chain}:${period}`)!;
      const file = model.file;
      const readback: number[] = [];
      const readbackAll: number[] = [];
      for (let m = 0; m < model.members.length; m++) {
        for (const state of model.statesOf(m)) {
          if (state.directHf <= 0) continue;
          const direct = state.directHf / 1e4;
          if (direct > 10) continue;
          const v = model.value(state, model.rowAt(state.readBlock), state.readT);
          if (!(v.debt > 0)) continue;
          const error = Math.abs(v.capacity / v.debt / direct - 1);
          readbackAll.push(error);
          if (v.debt >= MIN_DEBT_USD) readback.push(error);
        }
      }
      const random: number[] = [];
      const near: number[] = [];
      const agree: Record<string, [number, number]> = Object.fromEntries(GRID.triggers.map((t) => [String(t), [0, 0]]));
      for (const row of sample?.rows ?? []) {
        if (row.chain !== chain || row.period !== period) continue;
        for (const [member, stratum, hf, debtUsd] of row.reads) {
          if (hf < 0 || debtUsd < MIN_DEBT_USD) continue;
          const direct = hf / 1e6;
          if (direct > 10) continue;
          const rebuilt = model.hfAt(member, row.block, row.t);
          if (!Number.isFinite(rebuilt)) continue;
          (stratum === 0 ? random : near).push(Math.abs(rebuilt / direct - 1));
          for (const t of GRID.triggers) {
            const cell = agree[String(t)]!;
            cell[1]++;
            if (rebuilt < t === direct < t) cell[0]++;
          }
        }
      }
      let headline: ErrorStats | null = null;
      if (period !== CALM_ID) {
        const index = new Map(model.members.map((u, i) => [u, i]));
        const errors: number[] = [];
        for (const p of positions) {
          if (p.chain !== chain || p.window !== period || p.scope === 'no_usdc_debt') continue;
          const m = index.get(p.user);
          if (m === undefined) continue;
          for (const [block, t, capacity, debt] of decodeObserved(p.observed!)) {
            if (debt < MIN_DEBT_USD) continue;
            const rebuilt = model.hfAt(m, block, t);
            if (Number.isFinite(rebuilt)) errors.push(Math.abs(rebuilt / (capacity / debt) - 1));
          }
        }
        headline = stats(errors);
      }
      rows.push({
        chain,
        period,
        candidates: file.census.candidates,
        startMembers: file.census.startMembers,
        newcomers: file.census.newcomers,
        totalSupplyGap: Number(BigInt(file.census.totalSupply) - BigInt(file.census.sumOfStartBalances)) / Number(BigInt(file.census.totalSupply)),
        readback: stats(readback),
        readbackAll: stats(readbackAll),
        sampleRandom: stats(random),
        sampleNear: stats(near),
        sampleAgreement: Object.fromEntries(Object.entries(agree).map(([t, [ok, n]]) => [t, n ? ok / n : NaN])),
        headline,
      });
    }
  }
  return rows;
}

// ---------- Everything ----------

export interface PeriodInfo {
  period: string;
  label: string;
  days: number;
  chains: Array<{ chain: ChainKey; fromBlock: number; toBlock: number; members: number; armed: number; startMembers: number; newcomers: number; usdcDebtAtStart: number }>;
}

export interface Portfolio {
  base: typeof BASE;
  sharedSlowDelaySec: number;
  calm: CalmFile['choice'];
  periods: PeriodInfo[];
  population: PopulationRow[];
  populationByReserve: PopulationRow[];
  bySize: SizeRow[];
  realPairs: RealPairCount[];
  pairs: PairSetRow[];
  carry: CarryRow[];
  carryByPeriod: CarryRow[];
  breakEven: BreakEvenRow[];
  sharedBreakEven: Array<{ period: string; set: PairSetRow['set']; reserveShare: number; budget: number; extraBonusShared: number; extraPerDollar: number; crashesToPayIdle: number }>;
  validation: ValidationRow[];
}

export function buildPortfolio(): Portfolio {
  const markets = marketsOf();
  const prices: WindowPrices[] = [...readPrices(), ...readCalmPrices()];
  const positions = readPositions();
  const sample = existsSync(SAMPLE_FILE) ? readGz<SampleFile>(SAMPLE_FILE) : null;
  const ctx: Context = { models: new Map(), headline: new Map(), books: new Map() };
  const info = new Map<string, Pick<PopulationFile, 'census' | 'usdcRates' | 'fromBlock' | 'toBlock' | 'fromTime' | 'toTime'> & { members: number }>();

  const records: MemberRecord[] = [];
  const population: PopulationRow[] = [];
  const populationByReserve: PopulationRow[] = [];
  const bySize: SizeRow[] = [];
  const realPairs: RealPairCount[] = [];
  const pairs: PairSetRow[] = [];
  const validationRows: ValidationRow[] = [];

  // One period at a time: its two models, then everything that needs them, then let them go.
  for (const period of PERIODS) {
    ctx.models.clear();
    ctx.headline.clear();
    ctx.books.clear();
    if (period !== CALM_ID) {
      for (const chain of CHAINS_ORDER) ctx.books.set(chain, new PriceBook(prices.find((p) => p.chain === chain && p.window === period)!));
      for (const p of positions) if (p.scope !== 'no_usdc_debt' && p.window === period) ctx.headline.set(p.id, p);
    }
    for (const chain of CHAINS_ORDER) {
      const file = readPopulation(chain, period);
      info.set(`${chain}:${period}`, { census: file.census, usdcRates: file.usdcRates, fromBlock: file.fromBlock, toBlock: file.toBlock, fromTime: file.fromTime, toTime: file.toTime, members: file.members.length });
      const market = markets.find((m) => m.chain === chain && m.window === period && m.block === file.fromBlock)!;
      const price = prices.find((p) => p.chain === chain && p.window === period)!;
      ctx.models.set(`${chain}:${period}`, new PeriodModel(file, price, market));
    }
    const inPeriod: MemberRecord[] = [];
    for (const chain of CHAINS_ORDER) inPeriod.push(...memberRecords(ctx, chain, period));
    records.push(...inPeriod);

    for (const trigger of GRID.triggers) {
      for (const chain of CHAINS_ORDER) population.push(populationRow(inPeriod.filter((r) => r.chain === chain), chain, period, trigger, BASE.reserveShare));
      population.push(populationRow(inPeriod, 'all', period, trigger, BASE.reserveShare));
    }
    for (const reserveShare of GRID.reserveShares) {
      for (const chain of CHAINS_ORDER) populationByReserve.push(populationRow(inPeriod.filter((r) => r.chain === chain), chain, period, BASE.trigger, reserveShare));
      populationByReserve.push(populationRow(inPeriod, 'all', period, BASE.trigger, reserveShare));
    }
    bySize.push(...sizeRows(inPeriod, period));

    const base = new Map(inPeriod.filter((r) => r.chain === 'base' && r.start).map((r) => [r.user, r]));
    const real: Pair[] = inPeriod.filter((r) => r.chain === 'arbitrum' && r.start && base.has(r.user)).map((r) => ({ a: r, b: base.get(r.user)! }));
    real.sort((x, y) => byText(x.a.user, y.a.user));
    const withLiquidation = real.filter((p) => p.a.liquidated || p.b.liquidated).length;
    const crash = period !== CALM_ID;
    const syntheticAdded = crash && withLiquidation < REAL_PAIRS_NEEDED;
    realPairs.push({ period, pairs: real.length, withLiquidation, bothLiquidated: real.filter((p) => p.a.liquidated && p.b.liquidated).length, syntheticAdded });
    if (crash) {
      pairs.push(...evaluatePairs(ctx, real, period, 'real', 0));
      if (syntheticAdded) {
        const independent = syntheticPairs(inPeriod, period, false);
        pairs.push(...evaluatePairs(ctx, independent.pairs, period, 'synthetic, independent', independent.skipped));
        const both = syntheticPairs(inPeriod, period, true);
        pairs.push(...evaluatePairs(ctx, both.pairs, period, 'synthetic, both liquidated', both.skipped));
      }
    }
    validationRows.push(...validation(ctx, sample, positions, period));
  }
  ctx.models.clear();
  ctx.headline.clear();
  ctx.books.clear();

  // Carry.
  const daily = readJson<Record<ChainKey, DailyRow[]>>(join(DERIVED_DIR, 'daily.json'));
  const carry = CHAINS_ORDER.map((chain) =>
    carryRow(
      chain,
      '2025-01-01 to 2026-11-01, daily',
      daily[chain].map((r) => r.t),
      daily[chain].map((r) => r.borrowApr),
      daily[chain].map((r) => r.supplyApr),
    ),
  );
  const carryByPeriod: CarryRow[] = [];
  for (const period of PERIODS) {
    for (const chain of CHAINS_ORDER) {
      const rates = info.get(`${chain}:${period}`)!.usdcRates;
      const t = rates.t.reduce<number[]>((acc, d, i) => (acc.push(i === 0 ? d : acc[i - 1]! + d), acc), []);
      carryByPeriod.push(carryRow(chain, period, t, rates.borrowApr.map((x) => x / 1e8), rates.supplyApr.map((x) => x / 1e8)));
    }
  }

  // Break-evens, per crash window, at T 1.20 for every R.
  const carryOf = (chain: ChainKey): CarryRow => carry.find((c) => c.chain === chain)!;
  const breakEven: BreakEvenRow[] = [];
  for (const period of PERIODS.filter((p) => p !== CALM_ID)) {
    for (const reserveShare of GRID.reserveShares) {
      for (const chain of [...CHAINS_ORDER, 'all'] as const) {
        const row = populationByReserve.find((r) => r.period === period && r.chain === chain && r.reserveShare === reserveShare)!;
        const held = chain === 'all' ? CHAINS_ORDER.map((c) => populationByReserve.find((r) => r.period === period && r.chain === c && r.reserveShare === reserveShare)!) : [row];
        const weight = held.reduce((sum, r) => sum + r.reserveHeld, 0);
        const carryIdle = held.reduce((sum, r) => sum + r.reserveHeld * carryOf(r.chain as ChainKey).borrowApr, 0) / weight;
        const carryEarning = held.reduce((sum, r) => sum + r.reserveHeld * (carryOf(r.chain as ChainKey).borrowApr - carryOf(r.chain as ChainKey).supplyApr), 0) / weight;
        const perDollarLevee = row.bonusAvoidedLevee / row.reserveHeld;
        breakEven.push({
          period,
          chain,
          reserveShare,
          reserveHeld: row.reserveHeld,
          bonusAvoidedLevee: row.bonusAvoidedLevee,
          bonusAvoidedLeveeCapped: row.bonusAvoidedLeveeCapped,
          bonusAvoidedUpfront: row.bonusAvoidedUpfront,
          perDollarLevee,
          perDollarUpfront: row.bonusAvoidedUpfront / row.reserveHeld,
          carryIdle,
          carryEarning,
          crashesToPayIdle: carryIdle / perDollarLevee,
          crashesToPayEarning: carryEarning / perDollarLevee,
        });
      }
    }
  }
  const pooledIdle = (carry[0]!.borrowApr + carry[1]!.borrowApr) / 2;
  const sharedBreakEven = pairs.map((p) => {
    const extra = p.bonusAvoided.shared - p.bonusAvoided.upfront;
    const extraPerDollar = p.budget > 0 ? extra / p.budget : NaN;
    return { period: p.period, set: p.set, reserveShare: p.reserveShare, budget: p.budget, extraBonusShared: extra, extraPerDollar, crashesToPayIdle: extra > 0 ? pooledIdle / extraPerDollar : Infinity };
  });

  const calm = readJson<CalmFile>(join(DERIVED_DIR, 'calm.json'));
  const periods: PeriodInfo[] = PERIODS.map((period) => {
    const window = WINDOWS.find((w) => w.id === period);
    const label = window?.label ?? `${new Date(calm.choice.startTime * 1000).toISOString().slice(0, 10)} to ${new Date((calm.choice.endTime - 1) * 1000).toISOString().slice(0, 10)}`;
    return {
      period,
      label,
      days: Math.round((info.get(`base:${period}`)!.toTime - info.get(`base:${period}`)!.fromTime) / 86_400),
      chains: CHAINS_ORDER.map((chain) => {
        const file = info.get(`${chain}:${period}`)!;
        const usdcDebtAtStart = Number(BigInt(file.census.sumOfStartBalances) / 10n ** 6n);
        return {
          chain,
          fromBlock: file.fromBlock,
          toBlock: file.toBlock,
          members: file.members,
          armed: records.filter((r) => r.period === period && r.chain === chain).length,
          startMembers: file.census.startMembers,
          newcomers: file.census.newcomers,
          usdcDebtAtStart,
        };
      }),
    };
  });

  return {
    base: BASE,
    sharedSlowDelaySec: SHARED_SLOW_DELAY_SEC,
    calm: calm.choice,
    periods,
    population,
    populationByReserve,
    bySize,
    realPairs,
    pairs,
    carry,
    carryByPeriod,
    breakEven,
    sharedBreakEven,
    validation: validationRows,
  };
}
