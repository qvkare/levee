/**
 * The same report with one position's collateral marked down. Everything else stays as read, and
 * the result feeds the same line, so a simulation cannot use different maths from a reading. Pure.
 */
import { repayFigure } from "./aave-model.ts";
import { CHAINS } from "./chains.ts";
import { approxFall, standingForHealth } from "./math.ts";
import { assembleReport } from "./report.ts";
import type { AaveMarket, AavePosition, RiskReport } from "./types.ts";
import { buildLine, collateralAsset, firstAave } from "./line.ts";

export const MAX_FALL_PERCENT = 90;

export interface WhatIf {
  /** Fraction of collateral value lost. */
  fall: number;
  /** The asset that falls, or plain "Collateral". */
  asset: string;
  blockNumber: string | null;
}

/** A fall in percent from a query string. Null means no simulation. */
export function parseFall(input: string | null | undefined): number | null {
  if (input === null || input === undefined || input === "") return null;
  const value = Number(input);
  if (!Number.isFinite(value) || value <= 0 || value > MAX_FALL_PERCENT) return null;
  return value / 100;
}

function fallen(market: AaveMarket, position: AavePosition, fall: number, target: number): AavePosition {
  const scale = 1 - fall;
  const healthFactor = position.healthFactor === null ? null : position.healthFactor * scale;
  const reserves = position.reserves && {
    ...position.reserves,
    collateral: position.reserves.collateral.map((line) => ({ ...line, amount: line.amount, usd: line.usd * scale })),
  };
  const next = { ...position, collateralUsd: position.collateralUsd * scale, reserves, healthFactor, standing: standingForHealth(healthFactor) };
  return {
    ...next,
    dropToLiquidation: position.dropToLiquidation && healthFactor !== null ? { ...position.dropToLiquidation, fraction: approxFall(healthFactor) } : null,
    repay: repayFigure(next, CHAINS[market.chain].usdc, target),
  };
}

/** The nearest Aave position after the fall, or null when the address has no Aave debt. */
export function applyFall(report: RiskReport, fall: number): { report: RiskReport; whatIf: WhatIf } | null {
  const entry = firstAave(buildLine(report));
  if (!entry) return null;
  const market: AaveMarket = { ...entry.market, position: fallen(entry.market, entry.position, fall, report.target) };
  const { base, arbitrum } = report.aave;
  return {
    report: assembleReport({
      address: report.address,
      target: report.target,
      generatedAt: report.generatedAt,
      base: entry.chain === "base" ? market : base,
      arbitrum: entry.chain === "arbitrum" ? market : arbitrum,
      hyperliquid: report.hyperliquid,
      failures: report.failures,
    }),
    whatIf: { fall, asset: collateralAsset(entry.position) ?? "Collateral", blockNumber: entry.market.blockNumber },
  };
}
