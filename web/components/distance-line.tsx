"use client";

import { SCALE_MAX, SCALE_TICKS, scaleAt, triggerDistance, type LinePoint } from "@/lib/line.ts";
import { textWidth } from "@/lib/text-width.ts";
import { TYPE } from "@/lib/type-scale.ts";
import { useWidth } from "./use-width.ts";

interface Props {
  points: LinePoint[];
  /** Health factor trigger. The stretch of line under it is marked. */
  trigger: number | null;
  /** A point inside the last 5%. */
  crisisId?: string | null;
  /** Said on the line when there is nothing to place. */
  empty?: string;
  /** Server-side width before the browser measures. */
  fallbackWidth?: number;
}

const ROW = 40;
const GAP = 10;

interface Placed extends LinePoint {
  x: number;
  textX: number;
  anchor: "start" | "middle" | "end";
  side: "up" | "down";
  row: number;
}

/** The second line of a label. */
const detailLine = (point: LinePoint) => `${point.percent} · ${point.detail}${point.beyond ? " · off scale" : ""}`;

function labelWidth(point: LinePoint): number {
  return Math.max(textWidth(point.name, TYPE.s, 800), textWidth(detailLine(point), TYPE.xs, 600)) + 4;
}

/** Labels go above or below the line, nearest row first, wherever they do not touch a label already there. */
function place(points: LinePoint[], X: (point: LinePoint) => number, width: number, reserved: Array<{ side: "up" | "down"; row: number; from: number; to: number }>): Placed[] {
  const taken = [...reserved];
  return points.map((point) => {
    const x = X(point);
    const w = labelWidth(point);
    let from = x - w / 2;
    let anchor: Placed["anchor"] = "middle";
    let textX = x;
    if (from < 4) {
      from = 4;
      anchor = "start";
      textX = 4;
    } else if (x + w / 2 > width - 4) {
      from = width - 4 - w;
      anchor = "end";
      textX = width - 4;
    }
    const to = from + w;
    for (let row = 0; ; row += 1) {
      for (const side of ["up", "down"] as const) {
        const clash = taken.some((box) => box.side === side && box.row === row && box.from < to + GAP && from < box.to + GAP);
        if (!clash) {
          taken.push({ side, row, from, to });
          return { ...point, x, textX, anchor, side, row };
        }
      }
    }
  });
}

function Horizontal({ points, trigger, crisisId, empty, width }: Props & { width: number }) {
  const left = 40;
  const end = width - 90;
  const X = (point: LinePoint) => (point.beyond ? width - 34 : left + scaleAt(point.distance) * (end - left));
  const triggerAt = trigger === null ? null : left + scaleAt(triggerDistance(trigger)) * (end - left);
  const triggerText = trigger === null ? "" : `Under trigger ${trigger.toFixed(2)}`;
  const reserved = triggerAt === null ? [] : [{ side: "down" as const, row: 0, from: left + 16, to: left + 16 + textWidth(triggerText, TYPE.xs, 700) }];
  const placed = place(points, X, width, reserved);
  const upRows = Math.max(1, ...placed.filter((point) => point.side === "up").map((point) => point.row + 1));
  const downRows = Math.max(1, ...placed.filter((point) => point.side === "down").map((point) => point.row + 1));
  const y = 30 + 64 + (upRows - 1) * ROW;
  const height = y + 62 + (downRows - 1) * ROW + 70;

  return (
    <svg className="dist" viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true">
      {triggerAt !== null && (
        <>
          <rect className="f-amber-soft" x={left} y={y - 26} width={triggerAt - left} height={52} rx={6} />
          <text className="t-xs w7 f-amber-ink" x={left + 16} y={y + 44}>
            {triggerText}
          </text>
        </>
      )}
      <line className="dist-line" x1={left} x2={end} y1={y} y2={y} />
      <line className="dist-line dist-beyond" x1={end} x2={width - 24} y1={y} y2={y} />
      <rect className="f-ink" x={left - 30} y={y - 18} width={36} height={36} rx={8} />
      <text className="t-s w8 f-white" x={left - 12} y={y + 6} textAnchor="middle">
        0
      </text>
      <text className="t-xs w8 f-ink" x={left - 30} y={y - 30}>
        Liquidation
      </text>
      {SCALE_TICKS.map((tick) => {
        const x = left + scaleAt(tick) * (end - left);
        return (
          <g key={tick}>
            <line className="tick" x1={x} x2={x} y1={height - 34} y2={height - 28} />
            <text className="t-xs mono f-ink2" x={x} y={height - 12} textAnchor="middle">
              {Math.round(tick * 100)}%
            </text>
          </g>
        );
      })}
      {points.length === 0 && empty && (
        <text className="t-s w7 f-ink2" x={(left + end) / 2} y={y - 40} textAnchor="middle">
          {empty}
        </text>
      )}
      {placed.map((point) => {
        const up = point.side === "up";
        const ly = up ? y - 64 - point.row * ROW : y + 62 + point.row * ROW;
        return (
          <g key={point.id}>
            <line className="leader" x1={point.x} x2={point.x} y1={up ? y - 12 : y + 12} y2={up ? ly + 8 : ly - 30} />
            <text className="t-s w8 f-ink" x={point.textX} y={up ? ly - 14 : ly - 12} textAnchor={point.anchor}>
              {point.name}
            </text>
            <text className="t-xs w6 f-ink2" x={point.textX} y={up ? ly + 2 : ly + 4} textAnchor={point.anchor}>
              {detailLine(point)}
            </text>
          </g>
        );
      })}
      {placed.map((point) => (
        <circle key={point.id} className={`pos ${point.repayable ? "s-P" : "s-ink2"}${point.id === crisisId ? " pos-crisis" : ""}`} cx={point.x} cy={y} r={9} />
      ))}
    </svg>
  );
}

function Vertical({ points, trigger, crisisId, empty, width }: Props & { width: number }) {
  const top = 30;
  const x = 46;
  const base = 560;
  // Labels are pushed down until they clear each other and the captions at the top. The line grows to fit them.
  let last = trigger === null ? top - 6 : top + 12;
  const rows = points.map((point) => {
    const at = point.beyond ? 1 : scaleAt(point.distance);
    const label = Math.max(top + at * (base - 60), last + 36);
    last = label;
    return { point, at, label };
  });
  const height = Math.max(base, last + 40);
  const bottom = height - 30;
  const Y = (at: number) => top + at * (base - 60);
  const triggerAt = trigger === null ? null : Y(scaleAt(triggerDistance(trigger)));

  return (
    <svg className="dist" viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true">
      {triggerAt !== null && <rect className="f-amber-soft" x={x - 24} y={top} width={48} height={triggerAt - top} rx={6} />}
      <line className="dist-line" x1={x} x2={x} y1={top} y2={Math.max(Y(1), bottom)} />
      {SCALE_TICKS.map((tick) => (
        <text key={tick} className="t-xs mono f-ink2" x={x - 18} y={Y(scaleAt(tick)) + 4} textAnchor="end">
          {Math.round(tick * 100)}
        </text>
      ))}
      <text className="t-xs w8 f-ink" x={x + 30} y={top + 4}>
        Liquidation, 0%
      </text>
      {triggerAt !== null && trigger !== null && (
        <text className="t-xs w7 f-amber-ink" x={x + 30} y={top + 22}>
          Under trigger {trigger.toFixed(2)}
        </text>
      )}
      {points.length === 0 && empty && (
        <text className="t-s w7 f-ink2" x={x + 30} y={top + 80}>
          {empty}
        </text>
      )}
      {rows.map(({ point, at, label: ly }) => {
        const y = Y(at);
        return (
          <g key={point.id}>
            <line className="leader" x1={x + 12} x2={x + 40} y1={y} y2={ly} />
            <text className="t-s w8 f-ink" x={x + 46} y={ly + 1}>
              {point.name}
            </text>
            <text className="t-xs f-ink2" x={x + 46} y={ly + 17}>
              {detailLine(point)}
            </text>
            <circle className={`pos ${point.repayable ? "s-P" : "s-ink2"}${point.id === crisisId ? " pos-crisis" : ""}`} cx={x} cy={y} r={8} />
          </g>
        );
      })}
    </svg>
  );
}

/**
 * Every position at an address on one line, by its distance from liquidation on a square-root scale
 * to 250%. Blue rings are positions Levee can repay. Grey rings are positions it cannot reach.
 */
export function DistanceLine(props: Props) {
  const { ref, width, measured } = useWidth<HTMLDivElement>({ width: props.fallbackWidth ?? 1328, viewport: 1440, narrow: false });
  const summary = props.points.map((point) => `${point.name} ${point.percent}${point.beyond ? `, beyond ${Math.round(SCALE_MAX * 100)}%` : ""}`).join(", ");
  return (
    <div className="chart dist-frame" ref={ref} role="img" aria-label={props.points.length ? `Distance to liquidation: ${summary}.` : (props.empty ?? "No position to place.")} data-measured={measured || undefined}>
      {width < 560 ? <Vertical {...props} width={width} /> : <Horizontal {...props} width={width} />}
    </div>
  );
}
