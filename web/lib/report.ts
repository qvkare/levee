/** Assembles the report from the venue reads. Pure, and safe to import in the browser. */
import { repayFigure } from "./aave-model.ts";
import { CHAINS } from "./chains.ts";
import { standingForFall } from "./math.ts";
import { SCHEMA, type AaveMarket, type Failure, type HyperliquidAccount, type Nearest, type RiskReport, type Status } from "./types.ts";

function nearestReading(aave: RiskReport["aave"], hyperliquid: HyperliquidAccount): Nearest | null {
  const readings: Nearest[] = [];
  for (const market of Object.values(aave)) {
    const position = market.position;
    if (position?.dropToLiquidation) {
      readings.push({ venue: `aave.${market.chain}`, label: `Aave on ${CHAINS[market.chain].label}`, standing: position.standing, fall: position.dropToLiquidation.fraction });
    }
  }
  const perp = hyperliquid.positions.find((position) => position.distance !== null);
  if (perp && perp.distance !== null) {
    const fall = Math.max(0, perp.distance);
    const over = hyperliquid.marginRatio !== null && hyperliquid.marginRatio < 1;
    readings.push({ venue: "hyperliquid", label: `Hyperliquid ${perp.market}`, standing: over ? "liquidatable" : standingForFall(fall), fall: over ? 0 : fall });
  }
  return readings.sort((a, b) => a.fall - b.fall)[0] ?? null;
}

function overallStatus(statuses: Status[]): Status {
  if (statuses.every((status) => status === "ok")) return "ok";
  return statuses.every((status) => status === "unavailable") ? "unavailable" : "partial";
}

export function assembleReport(input: {
  address: string;
  target: number;
  generatedAt: string;
  base: AaveMarket;
  arbitrum: AaveMarket;
  hyperliquid: HyperliquidAccount;
  failures: Failure[];
}): RiskReport {
  const { address, target, generatedAt, base, arbitrum, hyperliquid, failures } = input;
  const aave = { base, arbitrum };
  return {
    schema: SCHEMA,
    address,
    generatedAt,
    status: overallStatus([base.status, arbitrum.status, hyperliquid.status]),
    target,
    failures,
    aave,
    hyperliquid,
    nearest: nearestReading(aave, hyperliquid),
  };
}

function marketForTarget(market: AaveMarket, target: number): AaveMarket {
  const position = market.position;
  if (!position?.repay) return market;
  return { ...market, position: { ...position, repay: repayFigure(position, CHAINS[market.chain].usdc, target) } };
}

/** The same report at a different target. Only the repay figures change. */
export function withTarget(report: RiskReport, target: number): RiskReport {
  return {
    ...report,
    target,
    aave: {
      base: marketForTarget(report.aave.base, target),
      arbitrum: marketForTarget(report.aave.arbitrum, target),
    },
  };
}
