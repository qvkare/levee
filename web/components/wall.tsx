import type { CSSProperties } from "react";
import type { RowModel } from "@/lib/wall.ts";

/** Numeric custom properties for the stylesheet. */
export const cssVars = (vars: Record<string, number>) => vars as unknown as CSSProperties;

function Row({ row }: { row: RowModel }) {
  return (
    <li className="row" data-tier={row.tier} style={cssVars({ "--d": row.d })}>
      <div className="lab">
        <b>{row.name}</b> <i className="first">{row.line}</i> {row.line2 && <i className="second">{row.line2}</i>} <i className="short">{row.short}</i>
      </div>
      <span className="stem" aria-hidden="true" />
      <div className="val" data-hollow={row.hollow || undefined}>
        {row.percent}
      </div>
    </li>
  );
}

/** Every number at its true distance from the wall, and its size set by that distance. */
export function Run({ rows, label }: { rows: RowModel[]; label: string }) {
  return (
    <ol className="run" role="list" aria-label={label}>
      {rows.map((row) => (
        <Row key={row.id} row={row} />
      ))}
    </ol>
  );
}

const TICKS = [25, 50, 75, 100];

export function Axis() {
  return (
    <div className="axis" aria-hidden="true">
      <span className="wlab">Liquidation</span>
      {TICKS.map((tick) => (
        <span key={tick} className="tick" style={cssVars({ "--t": tick })}>
          {tick}%
        </span>
      ))}
    </div>
  );
}
