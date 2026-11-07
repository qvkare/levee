/** Spec formulas. Pure, so the page and the API cannot disagree. */
import type { Stage } from "./types.ts";

export interface Debtor {
  collateralUsd: number;
  /** Weighted liquidation threshold, 0 to 1. */
  liquidationThreshold: number;
  debtUsd: number;
}

export const DEFAULT_TARGET = 1.5;
export const MIN_TARGET = 1.05;
export const MAX_TARGET = 5;

/** Spec section 7: for volatile collateral against stable debt, the drop is about 1 - 1/HF. */
export function approxFall(healthFactor: number): number {
  return healthFactor <= 1 ? 0 : 1 - 1 / healthFactor;
}

/** The health factor a given fall corresponds to. Used to set marks on the staff. */
export function healthForFall(fall: number): number {
  return 1 / (1 - fall);
}

/** Spec section 5: R = D - (C * L) / T, floored at zero and capped at the debt. */
export function repayToTarget({ collateralUsd, liquidationThreshold, debtUsd }: Debtor, target: number): number {
  if (debtUsd <= 0) return 0;
  const repay = debtUsd - (collateralUsd * liquidationThreshold) / target;
  return Math.min(debtUsd, Math.max(0, repay));
}

/** Health factor once `repayUsd` of debt is gone. Null when no debt remains. */
export function healthAfterRepay({ collateralUsd, liquidationThreshold, debtUsd }: Debtor, repayUsd: number): number | null {
  const left = debtUsd - repayUsd;
  return left <= 0 ? null : (collateralUsd * liquidationThreshold) / left;
}

/** Levee's reading bands. The two pairs are the same heights on the staff. */
export const ACTION_HEALTH = 1.25;
export const WATCH_HEALTH = 1.5;
export const ACTION_FALL = 0.2;
export const WATCH_FALL = 1 / 3;

export function stageForFall(fall: number): Stage {
  if (fall <= 0) return "flood";
  if (fall < ACTION_FALL) return "action";
  if (fall < WATCH_FALL) return "watch";
  return "normal";
}

/**
 * Compared on health factor, not on the fall, so the band edges land exactly on 1.25 and 1.50.
 * A health factor of exactly 1.00 is not yet liquidatable, so it is action stage.
 */
export function stageForHealth(healthFactor: number | null): Stage {
  if (healthFactor === null) return "dry";
  if (healthFactor < 1) return "flood";
  if (healthFactor < ACTION_HEALTH) return "action";
  return healthFactor < WATCH_HEALTH ? "watch" : "normal";
}

export function parseTarget(input: string | null | undefined): number | null {
  if (input === null || input === undefined || input === "") return DEFAULT_TARGET;
  const value = Number(input);
  if (!Number.isFinite(value) || value < MIN_TARGET || value > MAX_TARGET) return null;
  return value;
}
