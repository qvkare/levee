/**
 * Reads backtest/results/collateral.json at build time: repay from collateral against doing nothing,
 * a 30% reserve and the same USDC repaid upfront, over every native USDC borrower on Aave v3 Base and
 * Arbitrum in two crashes and a calm month. Only prerendered pages may call readCollateralBacktest,
 * because a Worker has no such folder.
 */
import { existsSync, readFileSync } from "node:fs";

export type CollateralMiss = "no_pool" | "no_warning" | "slippage_cap" | "under_minimum" | "too_slow" | "collateral_exhausted" | "usdc_debt_exhausted" | "follow_up_too_slow";

/** One cell of the population table: a period, a chain or all, a trigger, a price bound, a fee tier rule. */
export interface PopulationRow {
  period: string;
  chain: string;
  trigger: number;
  slippageBps: number;
  tier: string;
  members: number;
  armedBelow: number;
  liquidated: number;
  saved: number;
  savedArmedBelow: number;
  bonusAtRisk: number;
  bonusAvoided: number;
  swapCost: number;
  /** The swap cost with no unwind counted better than the oracle. */
  swapCostPositive: number;
  gas: number;
  gasReverted: number;
  net: number;
  swapCostArmedBelow: number;
  gasArmedBelow: number;
  sold: number;
  soldArmedBelow: number;
  collateralArmedAbove: number;
  reasons: Record<CollateralMiss | "saved", number>;
}

export interface SizeRow {
  period: string;
  /** "1. under $100", ordered by its number. */
  bucket: string;
  slippageBps: number;
  members: number;
  net: number;
  gas: number;
  swapCost: number;
  bonusAvoided: number;
}

export interface ComparisonRow {
  period: string;
  trigger: number;
  liquidated: number;
  bonusAtRisk: number;
  /** The reserve at 30% of debt. Capped counts a repay only up to the USDC debt left, as collateral mode does. */
  reserve: { saved: number; savedCapped: number | null; bonusAvoided: number; bonusAvoidedCapped: number | null };
  upfront: { saved: number; bonusAvoided: number };
  check: { members: number };
}

export interface CollateralBacktest {
  base: { trigger: number; target: number; delaySec: number; cooldownSec: number };
  rules: { slippageBps: number[]; gasPerUnwind: number };
  periods: Array<{ period: string; label: string; days: number }>;
  population: PopulationRow[];
  bySize: SizeRow[];
  comparison: ComparisonRow[];
}

export function collateralBacktestPath(): string {
  return process.env.LEVEE_BACKTEST_COLLATERAL || `${process.cwd()}/../backtest/results/collateral.json`;
}

export function readCollateralBacktest(path: string = collateralBacktestPath()): CollateralBacktest | null {
  if (!existsSync(/* turbopackIgnore: true */ path)) return null;
  try {
    const file = JSON.parse(readFileSync(/* turbopackIgnore: true */ path, "utf8")) as CollateralBacktest;
    return file.base && file.periods?.length && file.population?.length && file.comparison?.length ? file : null;
  } catch {
    return null;
  }
}

/** The headline cell of a period at one bound: both chains, the base trigger, the cheapest tier. */
export function headlineRow(backtest: CollateralBacktest, period: string, slippageBps: number): PopulationRow | null {
  return backtest.population.find((row) => row.period === period && row.chain === "all" && row.trigger === backtest.base.trigger && row.slippageBps === slippageBps && row.tier === "cheapest") ?? null;
}

/** Plain names for each way a liquidated position was missed, from collateral.md's own definitions. */
export const COLLATERAL_MISS_NAMES: Record<CollateralMiss, string> = {
  slippage_cap: "An unwind was refused on the bound, or no pool could fill it",
  follow_up_too_slow: "The next unwind was in flight or cooling down",
  usdc_debt_exhausted: "All USDC debt was repaid, and it still fell",
  collateral_exhausted: "The sellable collateral ran out",
  under_minimum: "Every unwind asked for was under the $1 floor",
  no_pool: "No collateral had a usable pool",
  too_slow: "A liquidator won the race",
  no_warning: "No reading below the trigger before the liquidation",
};
