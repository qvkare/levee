// The repay-from-collateral results. Reads committed files only: the population and headline
// paths, the pools, the quotes, and the reserve-mode results it is compared with.
import { join } from 'node:path';
import { CALM_ID, WINDOWS, type ChainKey } from '../config.ts';
import { GRID } from '../grid.ts';
import { existsSync, readJson, RESULTS_DIR } from '../paths.ts';
import { SIZE_BUCKETS } from '../report/aggregate.ts';
import type { CollateralReason, Execution, UnwindRequest } from '../sim/unwind.ts';
import { GAS_PER_UNWIND, HIGHEST_TRIGGER, LADDER_STEPS_PER_DECADE, MIN_UNWIND_USD, PROBE_MAX_BPS, PROBE_USDC, REPEAT_REVERTS_PRICED, REPEAT_WINDOW_SEC, SLIPPAGE_BPS } from './config.ts';
import { COLLATERAL_DIR, readPools, type PeriodPools } from './pools.ts';
import { anchorsOf, makeExecutor, QuoteBook, readQuotes } from './quotes.ts';
import {
  allPositions,
  allPrices,
  BASE,
  configKey,
  executorOptions,
  HEADLINE_RUNS,
  loadContext,
  marketsOf,
  memberCases,
  paramsOf,
  pathOf,
  POPULATION_RUNS,
  runOne,
  runsFor,
  type MemberCase,
  type PeriodContext,
  type RunConfig,
  type RunResult,
} from './runs.ts';

const CHAINS_ORDER: ChainKey[] = ['arbitrum', 'base'];
const PERIODS = [...WINDOWS.map((w) => w.id), CALM_ID];
export const REASONS: CollateralReason[] = ['saved', 'no_pool', 'no_warning', 'slippage_cap', 'under_minimum', 'too_slow', 'collateral_exhausted', 'usdc_debt_exhausted', 'follow_up_too_slow'];
const emptyReasons = (): Record<CollateralReason, number> => Object.fromEntries(REASONS.map((r) => [r, 0])) as Record<CollateralReason, number>;

/** Sums over a group of members for one run. Additive, so chains add up to 'all'. */
export interface Totals {
  members: number;
  noPool: number;
  simulated: number;
  armedBelow: number;
  crossed: number;
  liquidated: number;
  crossedLiquidated: number;
  crossedBelow1: number;
  falseAlarms: number;
  liquidatedNoPool: number;
  bonusAtRiskNoPool: number;
  saved: number;
  savedArmedBelow: number;
  bonusAtRisk: number;
  bonusAvoided: number;
  bonusAvoidedArmedAbove: number;
  reasons: Record<CollateralReason, number>;
  sent: number;
  landed: number;
  revertedCap: number;
  revertedLiquidity: number;
  unresolved: number;
  repaid: number;
  sold: number;
  swapCost: number;
  swapCostPositive: number;
  gap: number;
  gas: number;
  gasReverted: number;
  /** Members not liquidated in reality: they survived anyway. */
  swapCostSurvivors: number;
  gasSurvivors: number;
  soldSurvivors: number;
  swapCostFalseAlarms: number;
  gasFalseAlarms: number;
  soldFalseAlarms: number;
  /** Collateral at arming of false alarms that have a usable pool. */
  collateralFalseAlarms: number;
  falseAlarmsWithUnwind: number;
  swapCostArmedBelow: number;
  soldArmedBelow: number;
  /** Collateral at arming of members armed above T that have a usable pool. */
  collateralArmedAbove: number;
  gasArmedBelow: number;
  /** Swap cost and gas on liquidated members, saved or not. */
  swapCostLiquidated: number;
  gasLiquidated: number;
  debtAtArming: number;
  /** Members with at least one unwind landed. */
  withUnwind: number;
}

function emptyTotals(): Totals {
  return {
    members: 0,
    noPool: 0,
    simulated: 0,
    armedBelow: 0,
    crossed: 0,
    liquidated: 0,
    crossedLiquidated: 0,
    crossedBelow1: 0,
    falseAlarms: 0,
    liquidatedNoPool: 0,
    bonusAtRiskNoPool: 0,
    saved: 0,
    savedArmedBelow: 0,
    bonusAtRisk: 0,
    bonusAvoided: 0,
    bonusAvoidedArmedAbove: 0,
    reasons: emptyReasons(),
    sent: 0,
    landed: 0,
    revertedCap: 0,
    revertedLiquidity: 0,
    unresolved: 0,
    repaid: 0,
    sold: 0,
    swapCost: 0,
    swapCostPositive: 0,
    gap: 0,
    gas: 0,
    gasReverted: 0,
    swapCostSurvivors: 0,
    gasSurvivors: 0,
    soldSurvivors: 0,
    swapCostFalseAlarms: 0,
    gasFalseAlarms: 0,
    soldFalseAlarms: 0,
    collateralFalseAlarms: 0,
    falseAlarmsWithUnwind: 0,
    swapCostArmedBelow: 0,
    soldArmedBelow: 0,
    collateralArmedAbove: 0,
    gasArmedBelow: 0,
    swapCostLiquidated: 0,
    gasLiquidated: 0,
    debtAtArming: 0,
    withUnwind: 0,
  };
}

function addInto(into: Totals, from: Totals): void {
  for (const key of Object.keys(from) as Array<keyof Totals>) {
    if (key === 'reasons') for (const r of REASONS) into.reasons[r] += from.reasons[r];
    else (into[key] as number) += from[key] as number;
  }
}

const NOTHING: RunResult = { saved: true, reason: null, sent: 0, landed: 0, reverted: 0, revertedCap: 0, revertedLiquidity: 0, unresolved: 0, repaid: 0, soldUsd: 0, swapCost: 0, swapCostPositive: 0, gap: 0, gas: 0, gasReverted: 0, costsBps: [], fees: [] };

/**
 * The outcome of a member that is not simulated. A liquidated member is always simulated unless it
 * has no usable pool, so it is no_pool. Any other is a survivor that never unwinds.
 */
function unsimulated(c: MemberCase): RunResult {
  return c.liquidated ? { ...NOTHING, saved: false, reason: 'no_pool' } : NOTHING;
}

/** Adds one member's run to `t`, as the portfolio part counts members, crossings and false alarms. */
function count(t: Totals, c: MemberCase, r: RunResult, trigger: number): void {
  t.members++;
  t.debtAtArming += c.armDebt;
  if (c.asset === null) t.noPool++;
  if (c.simulated) t.simulated++;
  const below = c.armHf < trigger;
  let falseAlarm = false;
  if (below) t.armedBelow++;
  else if (c.liquidated || c.minHf < trigger) {
    t.crossed++;
    if (c.liquidated) t.crossedLiquidated++;
    else if (c.minHf < 1) t.crossedBelow1++;
    else {
      t.falseAlarms++;
      falseAlarm = true;
    }
  }
  t.sent += r.sent;
  t.landed += r.landed;
  t.revertedCap += r.revertedCap;
  t.revertedLiquidity += r.revertedLiquidity;
  t.unresolved += r.unresolved;
  t.repaid += r.repaid;
  t.sold += r.soldUsd;
  t.swapCost += r.swapCost;
  t.swapCostPositive += r.swapCostPositive;
  t.gap += r.gap;
  t.gas += r.gas;
  t.gasReverted += r.gasReverted;
  if (r.landed > 0) t.withUnwind++;
  if (below) {
    t.swapCostArmedBelow += r.swapCost;
    t.soldArmedBelow += r.soldUsd;
    t.gasArmedBelow += r.gas;
  } else if (c.asset !== null) {
    t.collateralArmedAbove += c.collateralUsd;
  }
  if (falseAlarm) {
    t.swapCostFalseAlarms += r.swapCost;
    t.gasFalseAlarms += r.gas;
    t.soldFalseAlarms += r.soldUsd;
    if (c.asset !== null) t.collateralFalseAlarms += c.collateralUsd;
    if (r.landed > 0) t.falseAlarmsWithUnwind++;
  }
  if (c.liquidated) {
    t.liquidated++;
    t.bonusAtRisk += c.bonusUsd;
    t.swapCostLiquidated += r.swapCost;
    t.gasLiquidated += r.gas;
    t.reasons[r.reason!]++;
    if (c.asset === null) {
      t.liquidatedNoPool++;
      t.bonusAtRiskNoPool += c.bonusUsd;
    }
    if (r.saved) {
      t.saved++;
      t.bonusAvoided += c.bonusUsd;
      if (below) t.savedArmedBelow++;
      else t.bonusAvoidedArmedAbove += c.bonusUsd;
    }
  } else {
    t.swapCostSurvivors += r.swapCost;
    t.gasSurvivors += r.gas;
    t.soldSurvivors += r.soldUsd;
  }
}

export interface PopulationRow extends Totals {
  period: string;
  chain: ChainKey | 'all';
  trigger: number;
  slippageBps: number;
  tier: RunConfig['tier'];
  net: number;
}

export interface SizeRow extends Totals {
  period: string;
  bucket: string;
  slippageBps: number;
  net: number;
}

export interface GridRow extends Totals {
  trigger: number;
  target: number;
  delaySec: number;
  cooldownSec: number;
  slippageBps: number;
  /** All headline positions, or one window. */
  window: string;
  net: number;
}

export interface Distribution {
  period: string;
  slippageBps: number;
  landed: number;
  p10: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
  /** Swap cost over USDC received, dollar-weighted, bps. */
  weightedBps: number;
  /** Share of swap cost from the pool's price before the swap against the oracle. */
  gapShare: number;
  /** Landed unwinds by fee tier. */
  byFee: Record<string, number>;
}

export interface Comparison {
  period: string;
  trigger: number;
  liquidated: number;
  bonusAtRisk: number;
  /** From results/portfolio.json, R 30%. */
  reserve: { saved: number; savedCapped: number | null; bonusAvoided: number; bonusAvoidedCapped: number | null };
  upfront: { saved: number; bonusAvoided: number };
  /** Liquidated and bonus at risk in portfolio.json, which must match this file's. */
  check: { liquidated: number; bonusAtRisk: number; members: number };
}

export interface FalseAlarmShare {
  period: string;
  slippageBps: number;
  /** Per false alarm with an unwind landed: collateral sold over its collateral at arming. */
  median: number;
  p90: number;
}

export interface Validation {
  /** Landing block header time minus landing time, seconds, per chain. */
  landing: Array<{ chain: ChainKey; n: number; median: number; p95: number; min: number; max: number; within2s: number }>;
  /** AaveOracle price of the sold asset read with the quotes, against the committed price files at the same block. */
  oracle: Array<{ chain: ChainKey; n: number; exact: number; within1bp: number; maxBps: number }>;
  /** From data/derived/collateral/validation.json, written by the validation fetch. */
  network: unknown;
}

export interface CollateralReport {
  base: typeof BASE;
  rules: { gasPerUnwind: number; minUnwindUsd: number; ladderStepsPerDecade: number; slippageBps: readonly number[]; probeUsdc: number; probeMaxBps: number; highestTrigger: number; repeatRevertsPriced: number; repeatWindowSec: number };
  periods: Array<{ period: string; label: string; days: number }>;
  pools: Array<{ chain: ChainKey; period: string; block: number; assets: Array<{ symbol: string; tiers: number[]; configuredFee: number | null; usdcInConfigured: number }> }>;
  soldAssets: Array<{ period: string; chain: ChainKey; symbol: string; members: number; debtAtArming: number }>;
  population: PopulationRow[];
  bySize: SizeRow[];
  grid: GridRow[];
  comparison: Comparison[];
  /** From results/summary.json: the reserve mode on the headline set at R 30%, per T, G and D, and the upfront repay. */
  headlineReserve: Array<{ trigger: number; target: number; delaySec: number; saved: number; bonusAvoided: number }>;
  headlineUpfront: { saved: number; bonusAvoided: number; positions: number; bonusAtRisk: number };
  falseAlarmShares: FalseAlarmShare[];
  costs: Distribution[];
  validation: Validation;
}

const quantile = (sorted: number[], q: number): number => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : NaN);

/** Rounds dollar figures to cents, so the file does not carry float noise. */
function rounded<T extends Totals>(t: T): T {
  const out = { ...t, reasons: { ...t.reasons } };
  for (const key of Object.keys(out) as Array<keyof Totals>) {
    const v = out[key];
    if (typeof v === 'number' && !Number.isInteger(v)) (out as unknown as Record<string, number>)[key] = Math.round(v * 100) / 100;
  }
  return out;
}

const netOf = (t: Totals): number => t.bonusAvoided - t.swapCost - t.gas;

interface PortfolioJson {
  population: Array<{ period: string; chain: string; trigger: number; reserveShare: number; members: number; liquidated: number; bonusAtRisk: number; savedLevee: number; savedLeveeCapped: number; savedUpfront: number; bonusAvoidedLevee: number; bonusAvoidedLeveeCapped: number; bonusAvoidedUpfront: number }>;
  periods: Array<{ period: string; label: string; days: number }>;
}

interface SummaryJson {
  grid: Array<{ trigger: number; target: number; reserveShare: number; delaySec: number; saved: number; bonusAvoidedUsd: number; bonusAtRiskUsd: number; positions: number }>;
  fair: Array<{ reserveShare: number; positions: number; repayAtArming: number; bonusAvoidedRepayAtArmingUsd: number }>;
}

/** `only` limits the run to some chains and periods, for checking; the published run uses all of them. */
export function buildCollateral(only: { chain?: ChainKey; period?: string } = {}): CollateralReport {
  const allPools = readPools();
  const markets = marketsOf();
  const positions = allPositions();
  const prices = allPrices();
  const portfolio = readJson<PortfolioJson>(join(RESULTS_DIR, 'portfolio.json'));
  const summary = readJson<SummaryJson>(join(RESULTS_DIR, 'summary.json'));

  const pop = new Map<string, Totals>();
  const size = new Map<string, Totals>();
  const grid = new Map<string, Totals>();
  const shares = new Map<string, number[]>();
  const costs = new Map<string, { bps: number[]; received: number; swapCost: number; gap: number; byFee: Record<string, number> }>();
  const soldAssets = new Map<string, { period: string; chain: ChainKey; symbol: string; members: number; debtAtArming: number }>();
  const landing = new Map<ChainKey, number[]>();
  const oracle = new Map<ChainKey, number[]>();
  const bucketOf = (debt: number): string => {
    const i = SIZE_BUCKETS.findIndex((b) => debt >= b.min && debt < b.max);
    return `${i + 1}. ${SIZE_BUCKETS[i]!.label}`;
  };
  const totals = (map: Map<string, Totals>, key: string): Totals => {
    let t = map.get(key);
    if (!t) {
      t = emptyTotals();
      map.set(key, t);
    }
    return t;
  };
  const baseKey = (slippageBps: number): string => configKey({ trigger: BASE.trigger, target: BASE.target, delaySec: BASE.delaySec, cooldownSec: BASE.cooldownSec, slippageBps, tier: 'cheapest' });

  for (const period of PERIODS) {
    if (only.period && only.period !== period) continue;
    for (const chain of CHAINS_ORDER) {
      if (only.chain && only.chain !== chain) continue;
      const ctx: PeriodContext = loadContext(chain, period, allPools, markets, positions, prices);
      const book = new QuoteBook(readQuotes(chain, period), anchorsOf(ctx.prices));
      const symbols = ctx.model.file.assets.map((asset) => ctx.pools.assets.find((a) => a.address === asset)?.symbol ?? asset);
      for (const c of memberCases(ctx)) {
        const runs = runsFor(c.headline);
        const results = new Map<string, RunResult>();
        if (c.simulated) {
          const path = pathOf(ctx, c);
          for (const run of runs) {
            const executor = makeExecutor(book, executorOptions(ctx, c, run));
            const observed = (request: UnwindRequest): Execution => {
              const e = executor(request);
              if (run.key === baseKey(SLIPPAGE_BPS[0]) && !e.standIn) {
                const row = book.row(e.block)!;
                (landing.get(chain) ?? landing.set(chain, []).get(chain)!).push(row.t - request.landsAt);
                const committed = ctx.model.priceAt(c.asset!, ctx.model.rowAt(e.block)) * 1e8;
                (oracle.get(chain) ?? oracle.set(chain, []).get(chain)!).push(Math.abs(row.prices.get(c.asset!)! / committed - 1) * 1e4);
              }
              return e;
            };
            results.set(run.key, runOne(path, paramsOf(ctx, c, run), observed));
          }
        }
        const resultOf = (run: RunConfig): RunResult => results.get(run.key) ?? unsimulated(c);

        if (c.asset !== null) {
          const key = `${period}:${chain}:${symbols[c.asset]}`;
          const row = soldAssets.get(key) ?? { period, chain, symbol: symbols[c.asset]!, members: 0, debtAtArming: 0 };
          row.members++;
          row.debtAtArming += c.armDebt;
          soldAssets.set(key, row);
        }
        for (const run of POPULATION_RUNS) {
          const r = resultOf(run);
          count(totals(pop, `${period}:${chain}:${run.key}`), c, r, run.trigger);
          if (run.trigger === BASE.trigger && run.tier === 'cheapest') {
            count(totals(size, `${period}:${bucketOf(c.armDebt)}:${run.slippageBps}`), c, r, run.trigger);
            const falseAlarm = c.armHf >= run.trigger && !c.liquidated && c.minHf < run.trigger && c.minHf >= 1;
            if (falseAlarm && r.landed > 0) (shares.get(`${period}:${run.slippageBps}`) ?? shares.set(`${period}:${run.slippageBps}`, []).get(`${period}:${run.slippageBps}`)!).push(r.soldUsd / c.collateralUsd);
            const d = costs.get(`${period}:${run.slippageBps}`) ?? { bps: [], received: 0, swapCost: 0, gap: 0, byFee: {} };
            d.bps.push(...r.costsBps);
            d.received += r.repaid;
            d.swapCost += r.swapCost;
            d.gap += r.gap;
            for (const fee of r.fees) d.byFee[String(fee)] = (d.byFee[String(fee)] ?? 0) + 1;
            costs.set(`${period}:${run.slippageBps}`, d);
          }
        }
        if (c.headline) {
          for (const run of runs) {
            if (run.tier !== 'cheapest') continue;
            const r = resultOf(run);
            count(totals(grid, `all:${run.key}`), c, r, run.trigger);
            count(totals(grid, `${period}:${run.key}`), c, r, run.trigger);
          }
        }
      }
    }
  }

  const population: PopulationRow[] = [];
  for (const period of PERIODS) {
    for (const run of POPULATION_RUNS) {
      const all = emptyTotals();
      for (const chain of CHAINS_ORDER) {
        const t = pop.get(`${period}:${chain}:${run.key}`) ?? emptyTotals();
        addInto(all, t);
        population.push(rounded({ ...t, period, chain, trigger: run.trigger, slippageBps: run.slippageBps, tier: run.tier, net: netOf(t) }));
      }
      population.push(rounded({ ...all, period, chain: 'all', trigger: run.trigger, slippageBps: run.slippageBps, tier: run.tier, net: netOf(all) }));
    }
  }
  const bySize: SizeRow[] = [];
  for (const period of PERIODS) {
    for (const slippageBps of SLIPPAGE_BPS) {
      SIZE_BUCKETS.forEach((b, i) => {
        const t = size.get(`${period}:${i + 1}. ${b.label}:${slippageBps}`) ?? emptyTotals();
        bySize.push(rounded({ ...t, period, bucket: `${i + 1}. ${b.label}`, slippageBps, net: netOf(t) }));
      });
    }
  }
  const gridRows: GridRow[] = [];
  const gridRuns = [...new Map([...POPULATION_RUNS, ...HEADLINE_RUNS].filter((r) => r.tier === 'cheapest').map((r) => [r.key, r])).values()];
  for (const window of ['all', ...WINDOWS.map((w) => w.id)]) {
    for (const run of gridRuns) {
      const t = grid.get(`${window}:${run.key}`);
      if (!t) continue;
      gridRows.push(rounded({ ...t, trigger: run.trigger, target: run.target, delaySec: run.delaySec, cooldownSec: run.cooldownSec, slippageBps: run.slippageBps, window, net: netOf(t) }));
    }
  }

  const comparison: Comparison[] = [];
  for (const period of PERIODS) {
    for (const trigger of GRID.triggers) {
      const p = portfolio.population.find((r) => r.period === period && r.chain === 'all' && r.trigger === trigger && r.reserveShare === 0.3)!;
      comparison.push({
        period,
        trigger,
        liquidated: p.liquidated,
        bonusAtRisk: p.bonusAtRisk,
        reserve: { saved: p.savedLevee, savedCapped: trigger === BASE.trigger ? p.savedLeveeCapped : null, bonusAvoided: p.bonusAvoidedLevee, bonusAvoidedCapped: trigger === BASE.trigger ? p.bonusAvoidedLeveeCapped : null },
        upfront: { saved: p.savedUpfront, bonusAvoided: p.bonusAvoidedUpfront },
        check: { liquidated: p.liquidated, bonusAtRisk: p.bonusAtRisk, members: p.members },
      });
    }
  }
  const headlineReserve = summary.grid
    .filter((g) => g.reserveShare === 0.3)
    .map((g) => ({ trigger: g.trigger, target: g.target, delaySec: g.delaySec, saved: g.saved, bonusAvoided: g.bonusAvoidedUsd }));
  const fair = summary.fair.find((f) => f.reserveShare === 0.3)!;
  const headlineUpfront = { saved: fair.repayAtArming, bonusAvoided: fair.bonusAvoidedRepayAtArmingUsd, positions: fair.positions, bonusAtRisk: summary.grid[0]!.bonusAtRiskUsd };

  const falseAlarmShares: FalseAlarmShare[] = [];
  const distributions: Distribution[] = [];
  for (const period of PERIODS) {
    for (const slippageBps of SLIPPAGE_BPS) {
      const s = [...(shares.get(`${period}:${slippageBps}`) ?? [])].sort((a, b) => a - b);
      falseAlarmShares.push({ period, slippageBps, median: quantile(s, 0.5), p90: quantile(s, 0.9) });
      const d = costs.get(`${period}:${slippageBps}`) ?? { bps: [], received: 0, swapCost: 0, gap: 0, byFee: {} };
      const bps = [...d.bps].sort((a, b) => a - b);
      distributions.push({
        period,
        slippageBps,
        landed: bps.length,
        p10: quantile(bps, 0.1),
        p50: quantile(bps, 0.5),
        p90: quantile(bps, 0.9),
        p99: quantile(bps, 0.99),
        max: bps[bps.length - 1] ?? NaN,
        weightedBps: d.received > 0 ? (d.swapCost / d.received) * 1e4 : NaN,
        gapShare: d.swapCost !== 0 ? d.gap / d.swapCost : NaN,
        byFee: d.byFee,
      });
    }
  }

  const stat = (values: number[]): { n: number; median: number; p95: number; min: number; max: number } => {
    const s = [...values].sort((a, b) => a - b);
    return { n: s.length, median: quantile(s, 0.5), p95: quantile(s, 0.95), min: s[0] ?? NaN, max: s[s.length - 1] ?? NaN };
  };
  const validationFile = join(COLLATERAL_DIR, 'validation.json');
  const validation: Validation = {
    landing: CHAINS_ORDER.map((chain) => {
      const v = landing.get(chain) ?? [];
      return { chain, ...stat(v), within2s: v.filter((x) => Math.abs(x) <= 2).length / Math.max(1, v.length) };
    }),
    oracle: CHAINS_ORDER.map((chain) => {
      const v = oracle.get(chain) ?? [];
      return { chain, n: v.length, exact: v.filter((x) => x === 0).length, within1bp: v.filter((x) => x <= 1).length, maxBps: Math.max(0, ...v) };
    }),
    network: existsSync(validationFile) ? readJson(validationFile) : null,
  };

  return {
    base: BASE,
    rules: { gasPerUnwind: GAS_PER_UNWIND, minUnwindUsd: MIN_UNWIND_USD, ladderStepsPerDecade: LADDER_STEPS_PER_DECADE, slippageBps: SLIPPAGE_BPS, probeUsdc: PROBE_USDC, probeMaxBps: PROBE_MAX_BPS, highestTrigger: HIGHEST_TRIGGER, repeatRevertsPriced: REPEAT_REVERTS_PRICED, repeatWindowSec: REPEAT_WINDOW_SEC },
    periods: portfolio.periods.map((p) => ({ period: p.period, label: p.label, days: p.days })),
    pools: allPools.map((p: PeriodPools) => ({
      chain: p.chain,
      period: p.period,
      block: p.block,
      assets: p.assets
        .filter((a) => a.configuredFee !== null)
        .map((a) => ({ symbol: a.symbol, tiers: a.tiers.filter((t) => t.usable).map((t) => t.fee), configuredFee: a.configuredFee, usdcInConfigured: Math.round(a.tiers.find((t) => t.fee === a.configuredFee)!.usdcBalance) })),
    })),
    soldAssets: [...soldAssets.values()].map((r) => ({ ...r, debtAtArming: Math.round(r.debtAtArming) })).sort((a, b) => a.period.localeCompare(b.period) || a.chain.localeCompare(b.chain) || b.debtAtArming - a.debtAtArming),
    population,
    bySize,
    grid: gridRows,
    comparison,
    headlineReserve,
    headlineUpfront,
    falseAlarmShares,
    costs: distributions,
    validation,
  };
}
