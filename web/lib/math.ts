/** Spec formulas. Pure, so the page and the API cannot disagree. */
import type { Standing } from "./types.ts";

export interface Debtor {
  collateralUsd: number;
  /** Weighted liquidation threshold, 0 to 1. */
  liquidationThreshold: number;
  debtUsd: number;
}

export const DEFAULT_TARGET = 1.5;
export const MIN_TARGET = 1.05;
export const MAX_TARGET = 3;

/** Spec section 7: for volatile collateral against stable debt, the drop is about 1 - 1/HF. */
export function approxFall(healthFactor: number): number {
  return healthFactor <= 1 ? 0 : 1 - 1 / healthFactor;
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

/** Aave's rule: at most half the debt goes at once while health is above 0.95 and both sides are large. */
const PARTIAL_LIQUIDATION_HEALTH = 0.95;
const PARTIAL_LIQUIDATION_MIN_USD = 2000;
const PARTIAL_LIQUIDATION_SHARE = 0.5;

export interface Liquidation {
  /** Debt the liquidator repays. */
  repaidUsd: number;
  /** Collateral the liquidator takes: the repaid amount plus the bonus. */
  takenUsd: number;
  /** The part of that which is the bonus. The borrower pays it. */
  bonusUsd: number;
  collateralLeftUsd: number;
  debtLeftUsd: number;
  healthAfter: number | null;
}

/**
 * Aave v3 LiquidationLogic, with the position treated as one collateral and one debt. A liquidator
 * repays debt and takes that value of collateral plus the bonus, up to what is there.
 */
export function liquidate({ collateralUsd, liquidationThreshold, debtUsd }: Debtor, bonus: number): Liquidation {
  const health = (collateralUsd * liquidationThreshold) / debtUsd;
  const large = collateralUsd >= PARTIAL_LIQUIDATION_MIN_USD && debtUsd >= PARTIAL_LIQUIDATION_MIN_USD;
  const covered = large && health > PARTIAL_LIQUIDATION_HEALTH ? debtUsd * PARTIAL_LIQUIDATION_SHARE : debtUsd;
  const takenUsd = Math.min(covered * (1 + bonus), collateralUsd);
  const repaidUsd = takenUsd / (1 + bonus);
  const collateralLeftUsd = collateralUsd - takenUsd;
  const debtLeftUsd = debtUsd - repaidUsd;
  return {
    repaidUsd,
    takenUsd,
    bonusUsd: takenUsd - repaidUsd,
    collateralLeftUsd,
    debtLeftUsd,
    healthAfter: debtLeftUsd > 0 ? (collateralLeftUsd * liquidationThreshold) / debtLeftUsd : null,
  };
}

export interface RescueInput extends Debtor {
  /** Fraction of collateral value lost, 0 to 1. */
  fall: number;
  trigger: number;
  target: number;
  reserveUsd: number;
  liquidationBonus: number;
}

export interface RescueResult {
  healthBefore: number | null;
  healthAfterFall: number | null;
  collateralAfterFallUsd: number;
  /** True when health after the fall is below the trigger and there is debt to repay. */
  triggered: boolean;
  /** Repay that reaches the target, before the reserve limits it. */
  neededUsd: number;
  /** What the reserve could pay. Zero when the trigger is not crossed. */
  repaidUsd: number;
  reserveLeftUsd: number;
  /** Health once any rescue has landed. */
  healthAfter: number | null;
  /** Fall from today that reaches the trigger, and that reaches 1.00. */
  fallToTrigger: number | null;
  fallToLiquidation: number | null;
  /** What a liquidator would do if the position still ends below 1.00. */
  liquidation: Liquidation | null;
}

const healthOf = ({ collateralUsd, liquidationThreshold, debtUsd }: Debtor) => (debtUsd > 0 ? (collateralUsd * liquidationThreshold) / debtUsd : null);

/** One position through one fall, with a reserve, in the terms of spec sections 2 and 5. */
export function simulateRescue(input: RescueInput): RescueResult {
  const { fall, trigger, target, reserveUsd, liquidationBonus, ...today } = input;
  const fallen: Debtor = { ...today, collateralUsd: today.collateralUsd * (1 - fall) };
  const healthBefore = healthOf(today);
  const healthAfterFall = healthOf(fallen);
  const triggered = healthAfterFall !== null && healthAfterFall < trigger;
  const neededUsd = triggered ? repayToTarget(fallen, target) : 0;
  const repaidUsd = Math.min(neededUsd, reserveUsd);
  const healthAfter = healthAfterRepay(fallen, repaidUsd);
  return {
    healthBefore,
    healthAfterFall,
    collateralAfterFallUsd: fallen.collateralUsd,
    triggered,
    neededUsd,
    repaidUsd,
    reserveLeftUsd: reserveUsd - repaidUsd,
    healthAfter,
    fallToTrigger: healthBefore === null ? null : Math.max(0, 1 - trigger / healthBefore),
    fallToLiquidation: healthBefore === null ? null : approxFall(healthBefore),
    liquidation: healthAfter !== null && healthAfter < 1 ? liquidate({ ...fallen, debtUsd: fallen.debtUsd - repaidUsd }, liquidationBonus) : null,
  };
}

/** Inside this distance a position is in its last 5%, and the page says so with all it has. */
export const LAST_STRETCH = 0.05;

export function standingForFall(fall: number): Standing {
  if (fall <= 0) return "liquidatable";
  return fall < LAST_STRETCH ? "close" : "open";
}

/** A health factor of exactly 1.00 is not yet liquidatable, so it reads as close. */
export function standingForHealth(healthFactor: number | null): Standing {
  if (healthFactor === null) return "none";
  if (healthFactor < 1) return "liquidatable";
  return approxFall(healthFactor) < LAST_STRETCH ? "close" : "open";
}

export function parseTarget(input: string | null | undefined): number | null {
  if (input === null || input === undefined || input === "") return DEFAULT_TARGET;
  const value = Number(input);
  if (!Number.isFinite(value) || value < MIN_TARGET || value > MAX_TARGET) return null;
  return value;
}
