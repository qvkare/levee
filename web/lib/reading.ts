/** The plain answer drawn from a report: one sentence and the chart model. Pure. */
import { CHAINS } from "./chains.ts";
import { STAGE_NAMES, percent, stageValue } from "./format.ts";
import type { ChainKey, PerpPosition, RiskReport, Stage } from "./types.ts";

const CHAIN_KEYS: ChainKey[] = ["base", "arbitrum"];

export interface ChartMark {
  id: string;
  name: string;
  value: string;
  fall: number;
}

/** reading: water at a level. over: past flood stage. dry: nothing to liquidate. out: no gauge answered. */
export type ChartState = "reading" | "over" | "dry" | "out";

export interface ChartModel {
  state: ChartState;
  /** Height of the water as a fall to liquidation. Null when there is no water to draw. */
  waterFall: number | null;
  marks: ChartMark[];
  /** Spoken description of the drawing. */
  summary: string;
}

function nearestPerp(report: RiskReport): PerpPosition | undefined {
  return report.hyperliquid.positions.find((position) => position.distance !== null);
}

export function chartModel(report: RiskReport): ChartModel {
  if (report.status === "unavailable") {
    return { state: "out", waterFall: null, marks: [], summary: "Gauge out of service. No source answered, so no level is drawn." };
  }
  const marks: ChartMark[] = [];
  for (const key of CHAIN_KEYS) {
    const position = report.aave[key].position;
    if (position?.healthFactor != null && position.dropToLiquidation) {
      marks.push({ id: key, name: `Aave on ${CHAINS[key].label}`, value: stageValue(position.healthFactor), fall: position.dropToLiquidation.fraction });
    }
  }
  const perp = nearestPerp(report);
  if (perp?.distance != null) {
    const distance = Math.max(0, perp.distance);
    marks.push({ id: "hyperliquid", name: `Hyperliquid ${perp.market}`, value: `${percent(distance)} to liquidation`, fall: distance });
  }
  if (marks.length === 0) return { state: "dry", waterFall: null, marks, summary: "Dry channel. Nothing at this address can be liquidated at the moment." };

  const sorted = [...marks].sort((a, b) => a.fall - b.fall);
  const lead = sorted[0] as ChartMark;
  const over = report.nearest?.stage === "flood";
  const levels = sorted.map((mark) => `${mark.name} ${mark.value}`).join(", ");
  return {
    state: over ? "over" : "reading",
    waterFall: lead.fall,
    marks: sorted,
    summary: over ? `Water is over the levee crest. ${levels}.` : `River section. Flood stage is at the crest, 1.00. Readings: ${levels}.`,
  };
}

const INCOMPLETE = " Some gauges did not answer, so this is not the whole picture.";

export interface Verdict {
  stage: Stage | null;
  text: string;
}

export function verdict(report: RiskReport): Verdict {
  if (report.status === "unavailable") return { stage: null, text: "No gauge answered, so nothing can be said about this address yet. Try again shortly." };

  const tail = report.status === "partial" ? INCOMPLETE : "";
  const nearest = report.nearest;
  if (!nearest) {
    const hasCollateral = CHAIN_KEYS.some((key) => (report.aave[key].position?.collateralUsd ?? 0) > 0);
    const hasPerps = report.hyperliquid.positions.length > 0;
    if (hasPerps) return { stage: "normal", text: `Hyperliquid reports no liquidation price for these positions, and there is no Aave debt.${tail}` };
    if (hasCollateral) return { stage: "dry", text: `Dry. There is collateral on Aave but no debt, so nothing can be liquidated.${tail}` };
    return { stage: "dry", text: `Dry. No Aave position on Base or Arbitrum and no open Hyperliquid positions.${tail}` };
  }

  if (nearest.venue === "hyperliquid") {
    const perp = nearestPerp(report) as PerpPosition;
    const where = `Hyperliquid ${perp.market} ${perp.side}`;
    if (nearest.stage === "flood") return { stage: "flood", text: `Over flood stage. The ${where} is at or past its liquidation price.${tail}` };
    return { stage: nearest.stage, text: `${where} is nearest flood stage: ${percent(nearest.fall)} from its liquidation price. ${STAGE_NAMES[nearest.stage]}.${tail}` };
  }

  const key = nearest.venue === "aave.base" ? "base" : "arbitrum";
  const position = report.aave[key].position;
  const health = stageValue(position?.healthFactor ?? 0);
  if (nearest.stage === "flood") return { stage: "flood", text: `Over flood stage. ${nearest.label} reads health factor ${health}, so liquidators can act now.${tail}` };
  return {
    stage: nearest.stage,
    text: `${nearest.label} is nearest flood stage, at health factor ${health}. ${STAGE_NAMES[nearest.stage]}: a fall of about ${percent(nearest.fall)} in collateral against debt reaches liquidation.${tail}`,
  };
}
