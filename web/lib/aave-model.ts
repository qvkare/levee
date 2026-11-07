/** Turns raw Aave reads into the reported position. No network here. */
import { approxFall, healthAfterRepay, repayToTarget, stageForHealth } from "./math.ts";
import type { AavePosition, DropToLiquidation, RepayFigure, ReserveLine, Reserves } from "./types.ts";

/** getUserAccountData outputs, in contract order. */
export type AccountData = readonly [bigint, bigint, bigint, bigint, bigint, bigint];

const MAX_UINT256 = 2n ** 256n - 1n;
const RAY = 10n ** 27n;
const HALF_RAY = RAY / 2n;

/** Aave's WadRayMath.rayMul: scaled balances times a ray index, rounded half up. */
export function rayMul(value: bigint, ray: bigint): bigint {
  return (value * ray + HALF_RAY) / RAY;
}

/** Bits 32 to 47 of a reserve's configuration word hold the bonus in basis points: 10500 is 5%. */
export function bonusFromConfiguration(data: bigint): number {
  return bonusFromBps(Number((data >> 32n) & 0xffffn));
}

export function bonusFromBps(bps: number): number {
  return bps > 10_000 ? (bps - 10_000) / 10_000 : 0;
}

/** Whether a reserve belongs to an e-mode category's collateral: one bit per reserve id. */
export function inEModeCategory(collateralBitmap: bigint, reserveId: number): boolean {
  return ((collateralBitmap >> BigInt(reserveId)) & 1n) === 1n;
}

export const ASSUMPTION = "All collateral falls together and the debt holds its value.";

const sum = (lines: ReserveLine[]) => lines.reduce((total, line) => total + line.usd, 0);
const symbols = (lines: ReserveLine[]) => [...new Set(lines.map((line) => line.symbol))].join(", ");

/** Below this share a holding is too small to change the reading. */
const NEGLIGIBLE = 0.01;

/** Says whether 1 - 1/HF can be read as a market fall for this position. */
export function assessAssumption(reserves: Reserves | null): Pick<DropToLiquidation, "assumptionHolds" | "note"> {
  if (!reserves) return { assumptionHolds: null, note: "Reserve detail was not read, so this assumption is unchecked." };
  const debtUsd = sum(reserves.debt);
  const collateralUsd = sum(reserves.collateral);
  const volatileDebt = reserves.debt.filter((line) => !line.stable);
  if (debtUsd > 0 && sum(volatileDebt) / debtUsd > NEGLIGIBLE) {
    return {
      assumptionHolds: false,
      note: `Debt includes ${symbols(volatileDebt)}, which moves with the market. Read this as a fall relative to the debt, not as a market fall.`,
    };
  }
  const stableCollateral = reserves.collateral.filter((line) => line.stable);
  const stableShare = collateralUsd > 0 ? sum(stableCollateral) / collateralUsd : 0;
  if (stableShare > 1 - NEGLIGIBLE) {
    return {
      assumptionHolds: false,
      note: "Collateral and debt are both stablecoins. Read this as the size of a depeg, not as a market fall.",
    };
  }
  if (stableShare > NEGLIGIBLE) {
    return {
      assumptionHolds: false,
      note: `${symbols(stableCollateral)} in the collateral holds its value, so the market fall needed is larger than this.`,
    };
  }
  return { assumptionHolds: true, note: null };
}

export function repayFigure(position: Pick<AavePosition, "collateralUsd" | "liquidationThreshold" | "debtUsd" | "reserves">, usdc: string, target: number): RepayFigure {
  const usd = repayToTarget(position, target);
  const usdcLines = position.reserves?.debt.filter((line) => line.asset.toLowerCase() === usdc.toLowerCase());
  const usdcDebtUsd = usdcLines ? sum(usdcLines) : null;
  return {
    target,
    usd,
    usdcDebtUsd,
    usdcCovers: usdcDebtUsd === null ? null : usdcDebtUsd >= usd,
    healthAfterAllUsdc: usdcDebtUsd ? healthAfterRepay(position, usdcDebtUsd) : null,
  };
}

export function buildPosition(account: AccountData, reserves: Reserves | null, usdc: string, target: number): AavePosition | null {
  const [totalCollateralBase, totalDebtBase, availableBorrowsBase, currentLiquidationThreshold, ltv, healthFactor] = account;
  if (totalCollateralBase === 0n && totalDebtBase === 0n) return null;

  const hasDebt = totalDebtBase > 0n && healthFactor !== MAX_UINT256;
  const health = hasDebt ? Number(healthFactor) / 1e18 : null;
  const base = {
    collateralUsd: Number(totalCollateralBase) / 1e8,
    debtUsd: Number(totalDebtBase) / 1e8,
    liquidationThreshold: Number(currentLiquidationThreshold) / 1e4,
    reserves,
  };
  return {
    ...base,
    stage: stageForHealth(health),
    healthFactor: health,
    ltv: Number(ltv) / 1e4,
    dropToLiquidation:
      health === null
        ? null
        : { approximate: true, fraction: approxFall(health), formula: "1 - 1/HF", assumption: ASSUMPTION, ...assessAssumption(reserves) },
    repay: health === null ? null : repayFigure(base, usdc, target),
    raw: {
      totalCollateralBase: totalCollateralBase.toString(),
      totalDebtBase: totalDebtBase.toString(),
      availableBorrowsBase: availableBorrowsBase.toString(),
      currentLiquidationThreshold: currentLiquidationThreshold.toString(),
      ltv: ltv.toString(),
      healthFactor: healthFactor.toString(),
    },
  };
}
