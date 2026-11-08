import type { CSSProperties } from "react";
import { countShare, integer, signedUsdShort, usdShort } from "@/lib/format.ts";
import type { CollateralFigures, PeriodFigures } from "@/lib/proof-model.ts";

const pct = (fraction: number) => `${Math.round(fraction * 100)}%`;
export const boundName = (bps: number) => `${bps / 100}% bound`;

interface Bar {
  key: string;
  label: string;
  saved: number;
  tone: "ink" | "ink-hollow" | "grey";
}

function barsOf(period: PeriodFigures): Bar[] {
  return [
    ...period.bounds.map((bound, index) => ({ key: `c${bound.bps}`, label: `From collateral, ${boundName(bound.bps)}`, saved: bound.saved, tone: index === 0 ? ("ink" as const) : ("ink-hollow" as const) })),
    { key: "reserve", label: `Reserve, ${pct(period.reserve.share)} of debt`, saved: period.reserve.saved, tone: "grey" },
    { key: "upfront", label: "Same USDC repaid upfront", saved: period.upfront.saved, tone: "grey" },
  ];
}

/** One period: of the positions really liquidated, how many each way saved. Doing nothing saved none. */
function Panel({ period }: { period: PeriodFigures }) {
  const bars = barsOf(period);
  return (
    <figure className="bt-panel">
      <figcaption>
        <b>{period.calm ? "Calm month" : "Crash"}</b> {period.range}
        <small>
          {integer(period.members)} borrowers, {integer(period.liquidated)} liquidated
        </small>
      </figcaption>
      <ol className="bars">
        <li className="bar-row bar-none">
          <span className="bar-label">Doing nothing</span>
          <span className="bar-val">
            0 saved. All {integer(period.liquidated)} paid {usdShort(period.bonusAtRisk)} of bonus
          </span>
        </li>
        {bars.map((bar) => (
          <li key={bar.key} className={`bar-row bar-${bar.tone}`}>
            <span className="bar-label">{bar.label}</span>
            <span className="bar-track" aria-hidden="true">
              <span className="bar" style={{ width: `${(bar.saved / period.liquidated) * 100}%` } as CSSProperties} />
            </span>
            <span className="bar-val">
              {integer(bar.saved)} <small>{countShare(bar.saved, period.liquidated)}%</small>
            </span>
          </li>
        ))}
      </ol>
      <p className="bt-net">
        Net from collateral: {period.bounds.map((bound) => `${signedUsdShort(bound.net)} at ${bound.bps / 100}%`).join(", ")}
      </p>
    </figure>
  );
}

/** Liquidated positions saved, three ways and doing nothing, in each period, at both bounds. */
export function BacktestChart({ backtest }: { backtest: CollateralFigures }) {
  return (
    <div className="bt-panels">
      {backtest.periods.map((period) => (
        <Panel key={period.key} period={period} />
      ))}
    </div>
  );
}
