/**
 * The few build-time figures a Worker-rendered page needs. next.config.ts runs this at build time
 * and inlines the result, because the Worker has no evidence or backtest folder to read.
 */
import { readBacktest } from "./backtest.ts";
import { readMpcLatency } from "./evidence.ts";
import type { Brief } from "./brief.ts";

export function readBrief(): Brief {
  const backtest = readBacktest();
  const signing = readMpcLatency();
  return {
    backtest: backtest && {
      positions: backtest.headline.cell.positions,
      trigger: backtest.headline.cell.trigger,
      target: backtest.headline.cell.target,
      delaySec: backtest.headline.cell.delaySec,
      rows: backtest.fair.map(({ reserveShare, positions, levee, holdAsCollateral }) => ({ reserveShare, leveeShare: levee / positions, collateralShare: holdAsCollateral / positions })),
    },
    signing: signing && { signed: signing.signed, runs: signing.runs, p50Ms: signing.p50Ms, slowestMs: signing.slowestMs },
  };
}
