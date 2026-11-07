/** The plain answer drawn from a report, in one sentence. Pure. */
import { percent, ratio } from "./format.ts";
import type { ChainKey, PerpPosition, RiskReport, Standing } from "./types.ts";

const CHAIN_KEYS: ChainKey[] = ["base", "arbitrum"];

const INCOMPLETE = " Some sources did not answer, so this is not the whole picture.";

export interface Verdict {
  standing: Standing | null;
  text: string;
}

function nearestPerp(report: RiskReport): PerpPosition | undefined {
  return report.hyperliquid.positions.find((position) => position.distance !== null);
}

export function verdict(report: RiskReport): Verdict {
  if (report.status === "unavailable") return { standing: null, text: "No source answered, so nothing can be said about this address yet. Try again shortly." };

  const tail = report.status === "partial" ? INCOMPLETE : "";
  const nearest = report.nearest;
  if (!nearest) {
    const hasCollateral = CHAIN_KEYS.some((key) => (report.aave[key].position?.collateralUsd ?? 0) > 0);
    const hasPerps = report.hyperliquid.positions.length > 0;
    if (hasPerps) return { standing: "open", text: `Hyperliquid reports no liquidation price for these positions, and there is no Aave debt.${tail}` };
    if (hasCollateral) return { standing: "none", text: `There is collateral on Aave but no debt, so nothing can be liquidated.${tail}` };
    return { standing: "none", text: `No Aave position on Base or Arbitrum and no open Hyperliquid positions.${tail}` };
  }

  if (nearest.venue === "hyperliquid") {
    const perp = nearestPerp(report) as PerpPosition;
    const where = `Hyperliquid ${perp.market} ${perp.side}`;
    if (nearest.standing === "liquidatable") return { standing: nearest.standing, text: `The ${where} is at or past its liquidation price.${tail}` };
    return { standing: nearest.standing, text: `${where} is first in line: ${percent(nearest.fall)} from its liquidation price.${tail}` };
  }

  const key = nearest.venue === "aave.base" ? "base" : "arbitrum";
  const health = ratio(report.aave[key].position?.healthFactor ?? 0);
  if (nearest.standing === "liquidatable") return { standing: nearest.standing, text: `${nearest.label} reads health factor ${health}, so liquidators can act now.${tail}` };
  return {
    standing: nearest.standing,
    text: `${nearest.label} is first in line, at health factor ${health}: a fall of about ${percent(nearest.fall)} in collateral against debt reaches liquidation.${tail}`,
  };
}
