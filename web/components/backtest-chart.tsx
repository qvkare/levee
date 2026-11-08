"use client";

import { countShare as share } from "@/lib/format.ts";
import type { BacktestRow } from "@/lib/proof-model.ts";
import { useWidth } from "./use-width.ts";

type Key = "levee" | "upfront" | "collateral";

const SERIES: Array<{ key: Key; tone: string; width: number }> = [
  { key: "collateral", tone: "grey", width: 8 },
  { key: "upfront", tone: "amber", width: 8 },
  { key: "levee", tone: "ink", width: 6 },
];

/** Survival by reserve size, three ways: Levee, the same USDC repaid upfront, and the same USDC held as collateral. */
export function BacktestChart({ rows }: { rows: BacktestRow[] }) {
  const { ref, width } = useWidth<HTMLDivElement>({ width: 820, viewport: 1440, narrow: false });
  const narrow = width < 560;
  const height = narrow ? 340 : 420;
  const left = narrow ? 46 : 48;
  const inset = narrow ? 24 : 44;
  const right = narrow ? 44 : 90;
  const top = 34;
  const bottom = height - 44;
  const X = (index: number) => left + inset + index * ((width - left - inset - right) / Math.max(1, rows.length - 1));
  const Y = (value: number) => bottom - (value / 100) * (bottom - top);
  const value = (row: BacktestRow, key: Key) => Number(share(row[key], row.positions));
  const label = rows.map((row) => `${Math.round(row.share * 100)}% reserve: Levee ${share(row.levee, row.positions)}%, upfront repay ${share(row.upfront, row.positions)}%, collateral ${share(row.collateral, row.positions)}%`).join(". ");

  return (
    <div className="chart" ref={ref}>
      <svg className="bt" viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={`Share of positions that survived, by reserve size. ${label}.`}>
        {[0, 25, 50, 75, 100].map((tick) => (
          <g key={tick}>
            <line className="grid-soft" x1={left} x2={width - right + 20} y1={Y(tick)} y2={Y(tick)} />
            <text className="t-xs mono f-ink2" x={left - 10} y={Y(tick) + 4} textAnchor="end">
              {tick}%
            </text>
          </g>
        ))}
        {rows.map((row, index) => (
          <text key={row.share} className="t-xs w7 f-ink" x={X(index)} y={height - 16} textAnchor="middle">
            {Math.round(row.share * 100)}%
          </text>
        ))}
        {SERIES.map((series) => (
          <polyline key={series.key} className={`bt-line s-${series.tone}`} strokeWidth={series.width} points={rows.map((row, index) => `${X(index)},${Y(value(row, series.key))}`).join(" ")} />
        ))}
        {rows.map((row, index) =>
          SERIES.map((series) => <circle key={`${row.share}-${series.key}`} className={`bt-dot s-${series.tone}`} cx={X(index)} cy={Y(value(row, series.key))} r={series.key === "levee" ? 5 : 6.5} />),
        )}
        {rows.map((row, index) => {
          const levee = value(row, "levee");
          const collateral = value(row, "collateral");
          const upfront = value(row, "upfront");
          if (index === rows.length - 1) {
            // At the last size the three lines meet, so their values stand in a column to the right, highest first.
            const column = [
              { key: "collateral", text: collateral, tone: "w7 f-grey-ink" },
              { key: "upfront", text: upfront, tone: "w8 f-amber-ink-2" },
              { key: "levee", text: levee, tone: "w8 f-ink" },
            ].sort((a, b) => b.text - a.text);
            const top = Y(column[0]?.text ?? 0) - 8;
            return (
              <g key={row.share}>
                {column.map((item, place) => (
                  <text key={item.key} className={`t-xs ${item.tone}`} x={X(index) + 14} y={top + place * 16}>
                    {item.text.toFixed(1)}
                  </text>
                ))}
              </g>
            );
          }
          return (
            <g key={row.share}>
              <text className="t-xs w8 f-ink" x={X(index)} y={Y(levee) - 16} textAnchor="middle">
                {levee.toFixed(1)}
              </text>
              <text className="t-xs w7 f-grey-ink" x={X(index)} y={Y(collateral) + 24} textAnchor="middle">
                {collateral.toFixed(1)}
              </text>
              {upfront !== levee && (
                <text className="t-xs w8 f-amber-ink-2" x={X(index) + 14} y={Y(upfront) + 16}>
                  {upfront.toFixed(1)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
