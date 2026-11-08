/**
 * Reads backtest/results/summary.json at build time. Every figure on the site comes from this file,
 * and the file's own warnings decide what is shown: one cell is not shown alone. Only prerendered pages
 * may call readBacktest, because a Worker has no such folder.
 */
import { existsSync, readFileSync } from "node:fs";

export type MissReason = "no_warning" | "too_slow" | "reserve_empty" | "usdc_debt_exhausted" | "follow_up_too_slow";

interface Cell {
  trigger: number;
  target: number;
  reserveShare: number;
  delaySec: number;
  positions: number;
  saved: number;
  notSaved: number;
  armedBelowTrigger: number;
  savedArmedBelowTrigger: number;
  reasons: Record<MissReason | "saved", number>;
  failedLaterInWindow: number;
  bonusAvoidedUsd: number;
  bonusAtRiskUsd: number;
  reserveHeldUsd: number;
  reserveUsedOnSavedUsd: number;
}

export interface FairRow {
  reserveShare: number;
  positions: number;
  levee: number;
  holdAsCollateral: number;
  repayAtArming: number;
  both: number;
  leveeOnly: number;
  collateralOnly: number;
  neither: number;
}

interface Population {
  chain: string;
  window: string;
  events: number;
  positions: number;
  inScope: number;
  excluded: number;
  liquidatedDebtUsd: number;
  grossBonusUsd: number;
}

interface WindowCell extends Cell {
  group: string;
}

export interface Backtest {
  headline: { cell: Cell; fair: FairRow };
  population: Population[];
  exclusions: Array<{ reason: string; positions: number }>;
  excludedPositions: number;
  fair: FairRow[];
  byWindow: WindowCell[];
  reserveNeeded: Array<{ group: string; positions: number; p50: number; above30Pct: number }>;
}

export function backtestPath(): string {
  return process.env.LEVEE_BACKTEST_SUMMARY || `${process.cwd()}/../backtest/results/summary.json`;
}

export function readBacktest(path: string = backtestPath()): Backtest | null {
  if (!existsSync(/* turbopackIgnore: true */ path)) return null;
  try {
    const summary = JSON.parse(readFileSync(/* turbopackIgnore: true */ path, "utf8")) as Backtest;
    return summary.headline?.cell && summary.fair?.length ? summary : null;
  } catch {
    return null;
  }
}

/** Where the replay flatters Levee, worked out so the site can say so at any new run. */
export interface Honest {
  /** Fired at arming, so no race happened. */
  armedBelow: number;
  /** Armed above the trigger: the positions where a race really ran. */
  armedAbove: number;
  savedArmedAbove: number;
  /** Reserve sizes where plain USDC collateral did at least as well. */
  collateralAtLeastAsGood: FairRow[];
  /** True when repaying the same USDC at the start did at least as well at every size. */
  repayAtArmingNeverWorse: boolean;
  /** Survived either way, so Levee added no survival benefit. */
  bothSurvive: number;
  /** Levee's repay came too late, and plain collateral would have held. */
  collateralOnly: number;
}

export function honestFigures({ headline, fair }: Backtest): Honest {
  const { cell, fair: row } = headline;
  return {
    armedBelow: cell.armedBelowTrigger,
    armedAbove: cell.positions - cell.armedBelowTrigger,
    savedArmedAbove: cell.saved - cell.savedArmedBelowTrigger,
    collateralAtLeastAsGood: fair.filter((entry) => entry.holdAsCollateral >= entry.levee),
    repayAtArmingNeverWorse: fair.every((entry) => entry.repayAtArming >= entry.levee),
    bothSurvive: row.both,
    collateralOnly: row.collateralOnly,
  };
}

/** Plain words for each way a position was missed, taken from the backtest's own definitions. */
export const MISS_MEANINGS: Record<MissReason, string> = {
  reserve_empty: "Repays landed, the reserve ran out, and health factor still fell below 1.00.",
  usdc_debt_exhausted: "Repays landed, all USDC debt was gone, and health factor still fell below 1.00.",
  too_slow: "Health factor crossed the trigger, but a liquidator won the race.",
  follow_up_too_slow: "Reserve remained, but the next repay was in flight or cooling down when health factor fell below 1.00.",
  no_warning: "No reading showed health factor below the trigger before the liquidation block.",
};

export const MISS_NAMES: Record<MissReason, string> = {
  reserve_empty: "Reserve ran out",
  usdc_debt_exhausted: "USDC debt ran out",
  too_slow: "Liquidator won the race",
  follow_up_too_slow: "Follow-up too slow",
  no_warning: "No warning",
};
