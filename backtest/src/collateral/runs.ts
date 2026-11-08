// Which members are run, with which parameters, and what each run keeps. Shared by the quote fetch
// and the offline report, so both walk exactly the same unwinds.
import { join } from 'node:path';
import { CALM_ID, type ChainKey } from '../config.ts';
import { decodeObserved, readPositions, readPrices, type DerivedPosition, type WindowPrices } from '../data.ts';
import type { MarketSnapshot } from '../fetch/reserves.ts';
import { PriceBook } from '../frozen.ts';
import { COOLDOWN_SEC, COOLDOWN_SENSITIVITY_SEC, GRID } from '../grid.ts';
import { DERIVED_DIR, readJson } from '../paths.ts';
import { readCalmPrices, readPopulation } from '../portfolio/data.ts';
import { PeriodModel } from '../portfolio/model.ts';
import { firstEpisodeBonus } from '../report/aggregate.ts';
import { simulateUnwind, type CollateralReason, type Execution, type Executor, type UnwindParams } from '../sim/unwind.ts';
import { HIGHEST_TRIGGER, MIN_UNWIND_USD, SLIPPAGE_BPS } from './config.ts';
import { chooseAsset, headlineHoldings, headlinePath, holdingsOf, memberPath, memberStart, type Holding } from './paths.ts';
import { usableTiers, type PeriodPools } from './pools.ts';
import { makeExecutor, type ExecutorOptions, type QuoteBook } from './quotes.ts';

export interface RunConfig {
  key: string;
  trigger: number;
  target: number;
  delaySec: number;
  cooldownSec: number;
  slippageBps: number;
  /** 'cheapest': any usable tier, the cheapest at each unwind. 'configured': the configured tier only. */
  tier: 'cheapest' | 'configured';
}

const config = (trigger: number, target: number, delaySec: number, cooldownSec: number, slippageBps: number, tier: RunConfig['tier']): RunConfig => ({
  key: `T${trigger}/G${target}/D${delaySec}/C${cooldownSec}/S${slippageBps}/${tier}`,
  trigger,
  target,
  delaySec,
  cooldownSec,
  slippageBps,
  tier,
});

/** The headline cell's target, delay and cooldown. */
export const BASE = { trigger: 1.2, target: 1.5, delaySec: 60, cooldownSec: COOLDOWN_SEC } as const;

/** Every member: every T at G 1.50, D 60 s, both caps, cheapest tier; and T 1.20 on the configured tier. */
export const POPULATION_RUNS: RunConfig[] = [
  ...GRID.triggers.flatMap((t) => SLIPPAGE_BPS.map((s) => config(t, BASE.target, BASE.delaySec, BASE.cooldownSec, s, 'cheapest'))),
  ...SLIPPAGE_BPS.map((s) => config(BASE.trigger, BASE.target, BASE.delaySec, BASE.cooldownSec, s, 'configured')),
];

/** Liquidated positions in the headline set: every T, G and D with T below G, both caps; and the cooldown sensitivity. */
export const HEADLINE_RUNS: RunConfig[] = [
  ...GRID.targets.flatMap((g) =>
    GRID.triggers.filter((t) => t < g).flatMap((t) => GRID.delaysSec.flatMap((d) => SLIPPAGE_BPS.map((s) => config(t, g, d, COOLDOWN_SEC, s, 'cheapest'))))),
  ...COOLDOWN_SENSITIVITY_SEC.flatMap((c) => SLIPPAGE_BPS.map((s) => config(BASE.trigger, BASE.target, BASE.delaySec, c, s, 'cheapest'))),
];

export const configKey = (c: Omit<RunConfig, 'key'>): string => config(c.trigger, c.target, c.delaySec, c.cooldownSec, c.slippageBps, c.tier).key;

/** The runs a member gets: the population runs, plus the headline grid for a headline position. Unique by key. */
export function runsFor(headline: boolean): RunConfig[] {
  const all = headline ? [...POPULATION_RUNS, ...HEADLINE_RUNS] : POPULATION_RUNS;
  const seen = new Set<string>();
  return all.filter((c) => !seen.has(c.key) && seen.add(c.key));
}

/** What a run keeps. Dollar figures in USD. */
export interface RunResult {
  saved: boolean;
  reason: CollateralReason | null;
  sent: number;
  landed: number;
  reverted: number;
  /** Reverted on the cap, and for lack of liquidity. */
  revertedCap: number;
  revertedLiquidity: number;
  unresolved: number;
  repaid: number;
  soldUsd: number;
  swapCost: number;
  /** Swap cost with each unwind floored at zero: gains from a pool priced above the oracle left out. */
  swapCostPositive: number;
  gap: number;
  gas: number;
  /** Gas paid by unwinds that reverted. A keeper that never sent a doomed unwind would save it. */
  gasReverted: number;
  /** Cost of each landed unwind against the oracle, bps, and its fee tier, for the distribution. */
  costsBps: number[];
  fees: number[];
}

export interface MemberCase {
  chain: ChainKey;
  period: string;
  member: number;
  user: string;
  start: boolean;
  headline: boolean;
  liquidated: boolean;
  liquidation: { block: number; t: number } | null;
  armDebt: number;
  armHf: number;
  /** Lowest HF from arming to the real liquidation, or to the period end, with no Levee. */
  minHf: number;
  bonusUsd: number;
  /** The asset the position sells, or null: no_pool. */
  asset: number | null;
  /** AaveOracle value of all the position's collateral at arming, and of the sold asset. */
  collateralUsd: number;
  assetUsd: number;
  /** Whether any run can unwind: liquidated, or below the highest trigger at some point. */
  simulated: boolean;
}

export interface PeriodContext {
  chain: ChainKey;
  period: string;
  model: PeriodModel;
  pools: PeriodPools;
  prices: WindowPrices;
  /** Crash windows only: the headline positions of this chain and window, by user. */
  headline: Map<string, DerivedPosition>;
  book: PriceBook | null;
}

export function marketsOf(): MarketSnapshot[] {
  return [...readJson<MarketSnapshot[]>(join(DERIVED_DIR, 'markets.json')), ...readJson<MarketSnapshot[]>(join(DERIVED_DIR, 'portfolio', 'markets-calm.json'))];
}

/** Loads one chain and period. `positions` and `prices` can be passed in to share them across calls. */
export function loadContext(chain: ChainKey, period: string, pools: PeriodPools[], markets: MarketSnapshot[], positions: DerivedPosition[], prices: WindowPrices[]): PeriodContext {
  const file = readPopulation(chain, period);
  const market = markets.find((m) => m.chain === chain && m.window === period && m.block === file.fromBlock);
  if (!market) throw new Error(`no market at ${chain} ${period}`);
  const price = prices.find((p) => p.chain === chain && p.window === period)!;
  const headline = new Map<string, DerivedPosition>();
  if (period !== CALM_ID) for (const p of positions) if (p.chain === chain && p.window === period && p.scope !== 'no_usdc_debt') headline.set(p.user, p);
  return {
    chain,
    period,
    model: new PeriodModel(file, price, market),
    pools: pools.find((p) => p.chain === chain && p.period === period)!,
    prices: price,
    headline,
    book: period === CALM_ID ? null : new PriceBook(price),
  };
}

export const allPrices = (): WindowPrices[] => [...readPrices(), ...readCalmPrices()];
export const allPositions = (): DerivedPosition[] => readPositions();

/** Every member of the period that the portfolio part counts, with its sold asset. Paths are not kept. */
export function memberCases(ctx: PeriodContext): MemberCase[] {
  const { model, pools } = ctx;
  const usable = (asset: number): boolean => usableTiers(pools, asset).length > 0;
  const out: MemberCase[] = [];
  for (let member = 0; member < model.members.length; member++) {
    const user = model.members[member]!;
    const position = ctx.headline.get(user);
    let holdings: Holding[];
    let base: Pick<MemberCase, 'liquidated' | 'liquidation' | 'armDebt' | 'armHf' | 'minHf' | 'bonusUsd'>;
    if (position) {
      // As the portfolio part: the committed path, armed at its first observation with debt.
      const { t, capacity, debt } = firstWithDebt(position);
      let minHf = Infinity;
      for (const [b, tt, c, d] of observedPoints(position)) if (b < position.liquidationBlock && tt >= t && d > 0) minHf = Math.min(minHf, c / d);
      base = { liquidated: true, liquidation: { block: position.liquidationBlock, t: position.liquidationTime }, armDebt: debt, armHf: capacity / debt, minHf, bonusUsd: firstEpisodeBonus(position) };
      holdings = headlineHoldings(model, member, ctx.book!, position);
    } else {
      const built = model.build(member);
      if (!built) continue;
      const start = memberStart(model, member)!;
      base = { liquidated: built.path.liquidation !== null, liquidation: built.path.liquidation, armDebt: built.armDebt, armHf: built.armHf, minHf: built.minHf, bonusUsd: built.bonusUsd };
      holdings = holdingsOf(model, start.arm, start.arm.applyBlock, start.arm.applyT);
    }
    const asset = chooseAsset(holdings, usable);
    out.push({
      chain: ctx.chain,
      period: ctx.period,
      member,
      user,
      start: member < model.file.census.startMembers,
      headline: position !== undefined,
      ...base,
      asset,
      collateralUsd: holdings.reduce((sum, h) => sum + h.valueUsd, 0),
      assetUsd: holdings.find((h) => h.asset === asset)?.valueUsd ?? 0,
      simulated: asset !== null && (base.liquidated || base.armHf < HIGHEST_TRIGGER || base.minHf < HIGHEST_TRIGGER),
    });
  }
  return out;
}

const observedPoints = (position: DerivedPosition): Array<[number, number, number, number]> => decodeObserved(position.observed!);
function firstWithDebt(position: DerivedPosition): { block: number; t: number; capacity: number; debt: number } {
  const p = observedPoints(position).find((q) => q[3] > 0);
  if (!p) throw new Error(`${position.id} has no debt`);
  return { block: p[0], t: p[1], capacity: p[2], debt: p[3] };
}

/** The path a member's runs use. */
export function pathOf(ctx: PeriodContext, c: MemberCase) {
  const position = ctx.headline.get(c.user);
  if (position) return headlinePath(ctx.model, c.member, ctx.book!, position, c.asset!);
  return memberPath(ctx.model, memberStart(ctx.model, c.member)!, c.asset!);
}

export function paramsOf(ctx: PeriodContext, c: MemberCase, run: RunConfig): UnwindParams {
  const configured = ctx.pools.assets.find((a) => a.asset === c.asset)!.configuredFee!;
  return {
    trigger: run.trigger,
    target: run.target,
    delaySec: run.delaySec,
    cooldownSec: run.cooldownSec,
    slippageBps: run.slippageBps,
    sizingFee: configured / 1e6,
    minUnwindUsd: MIN_UNWIND_USD,
  };
}

export function executorOptions(ctx: PeriodContext, c: MemberCase, run: RunConfig): Omit<ExecutorOptions, 'onMissing'> {
  const asset = ctx.pools.assets.find((a) => a.asset === c.asset)!;
  return {
    asset: c.asset!,
    fees: run.tier === 'cheapest' ? asset.tiers.filter((t) => t.usable).map((t) => t.fee) : [asset.configuredFee!],
    slippageBps: run.slippageBps,
  };
}

/** One run of one member, kept compact. */
export function runOne(path: ReturnType<typeof pathOf>, params: UnwindParams, execute: Executor): RunResult {
  const o = simulateUnwind(path, params, execute);
  const result: RunResult = {
    saved: o.saved,
    reason: o.reason,
    sent: o.sent,
    landed: o.landed,
    reverted: o.reverted,
    revertedCap: 0,
    revertedLiquidity: 0,
    unresolved: o.unresolved,
    repaid: o.repaidUsd,
    soldUsd: o.soldUsd,
    swapCost: o.swapCostUsd,
    swapCostPositive: 0,
    gap: o.gapUsd,
    gas: o.gasUsd,
    gasReverted: 0,
    costsBps: [],
    fees: [],
  };
  for (const a of o.attempts) {
    const e = a.execution;
    if (!e) continue;
    if (e.status !== 'landed') result.gasReverted += e.gasUsd;
    if (e.status === 'cap') result.revertedCap++;
    else if (e.status === 'liquidity') result.revertedLiquidity++;
    else {
      result.costsBps.push(((e.paidUsd - e.receivedUsd) / e.receivedUsd) * 1e4);
      result.swapCostPositive += Math.max(0, e.paidUsd - e.receivedUsd);
      result.fees.push(e.fee);
    }
  }
  return result;
}

/** Runs every config of a member against a quote book. The offline run's executor throws on a missing quote. */
export function runMember(ctx: PeriodContext, c: MemberCase, book: QuoteBook, runs: RunConfig[]): Map<string, RunResult> {
  const out = new Map<string, RunResult>();
  if (!c.simulated) return out;
  const path = pathOf(ctx, c);
  for (const run of runs) out.set(run.key, runOne(path, paramsOf(ctx, c, run), makeExecutor(book, executorOptions(ctx, c, run))));
  return out;
}

/** One unwind that reached its landing block, for the validation draws. */
export interface UnwindRecord {
  period: string;
  chain: ChainKey;
  member: number;
  run: string;
  landsAt: number;
  block: number;
  asset: number;
  amount: number;
  status: Execution['status'];
  /** A repeat revert taken from the run's last quoted unwind. */
  standIn: boolean;
  slippageBps: number;
  fees: number[];
}

/** Every resolved unwind of the given runs, in member and run order. */
export function collectUnwinds(ctx: PeriodContext, book: QuoteBook, runs: RunConfig[]): UnwindRecord[] {
  const out: UnwindRecord[] = [];
  for (const c of memberCases(ctx)) {
    if (!c.simulated) continue;
    const path = pathOf(ctx, c);
    for (const run of runs) {
      const options = executorOptions(ctx, c, run);
      const executor = makeExecutor(book, options);
      runOne(path, paramsOf(ctx, c, run), (request) => {
        const e = executor(request);
        out.push({
          period: ctx.period,
          chain: ctx.chain,
          member: c.member,
          run: run.key,
          landsAt: request.landsAt,
          block: e.block,
          asset: c.asset!,
          amount: request.amount,
          status: e.status,
          standIn: e.standIn === true,
          slippageBps: run.slippageBps,
          fees: options.fees,
        });
        return e;
      });
    }
  }
  return out;
}
