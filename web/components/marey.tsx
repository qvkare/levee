"use client";

import type { ProofRun } from "@/lib/proof-model.ts";
import type { LaneKey } from "./badge.tsx";
import { useWidth } from "./use-width.ts";

const STOPS: Array<{ label: string; lane: LaneKey }> = [
  { label: "Detected", lane: "K" },
  { label: "On NEAR", lane: "N" },
  { label: "Signed", lane: "M" },
  { label: "Sent", lane: "K" },
  { label: "Included", lane: "P" },
];

const HEIGHT = 330;

/** Every landed run as one line through the five moments of a rescue. Steeper is faster. */
export function Marey({ runs }: { runs: ProofRun[] }) {
  const { ref, width } = useWidth<HTMLDivElement>({ width: 720, viewport: 1440, narrow: false });
  const landed = runs.filter((run) => run.outcome === "success" && run.marks.included !== null);
  const totals = landed.map((run) => (run.marks.included as number) / 1000);
  if (landed.length === 0) return null;
  const slowest = Math.max(...totals);
  const fastest = Math.min(...totals);
  const replayed = landed.find((run) => run.replayed);
  const narrow = width < 560;
  const left = narrow ? 98 : 150;
  const right = width - 10;
  const span = slowest * (narrow ? 1.08 : 1.2);
  const X = (seconds: number) => left + (seconds / span) * (right - left);
  const Y = (index: number) => 20 + index * ((HEIGHT - 80) / 4);
  const ticks = Array.from({ length: Math.floor(slowest / 2) + 1 }, (_, index) => index * 2);
  const pointsOf = (run: ProofRun) => [0, run.marks.near, run.marks.signed, run.marks.sent, run.marks.included].map((ms, index) => `${X((ms ?? 0) / 1000)},${Y(index)}`).join(" ");
  const others = landed.filter((run) => !run.replayed);

  return (
    <div className="chart" ref={ref}>
      <svg className="marey" viewBox={`0 0 ${width} ${HEIGHT}`} width={width} height={HEIGHT} aria-hidden="true">
        {STOPS.map((stop, index) => (
          <g key={stop.label}>
            <line className="grid" x1={left} x2={right} y1={Y(index)} y2={Y(index)} />
            <rect className={`f-${stop.lane}`} x={0} y={Y(index) - 11} width={22} height={22} rx={6} />
            <text className="t-xs w8 f-white" x={11} y={Y(index) + 5.5} textAnchor="middle">
              {stop.lane}
            </text>
            <text className="t-xs w7 f-ink" x={30} y={Y(index) + 5}>
              {stop.label}
            </text>
          </g>
        ))}
        {ticks.map((second) => (
          <g key={second}>
            <text className="t-xs mono f-ink2" x={X(second)} y={HEIGHT - 14} textAnchor="middle">
              {second} s
            </text>
            <line className="tick" x1={X(second)} x2={X(second)} y1={Y(4) + 6} y2={Y(4) + 12} />
          </g>
        ))}
        {others.map((run) => (
          <polyline key={run.id} className="run-line" points={pointsOf(run)} />
        ))}
        {replayed && (
          <>
            <polyline className="run-line run-replayed" points={pointsOf(replayed)} />
            {[0, replayed.marks.near, replayed.marks.signed, replayed.marks.sent, replayed.marks.included].map((ms, index) => (
              <circle key={index} className="run-stop" cx={X((ms ?? 0) / 1000)} cy={Y(index)} r={5} />
            ))}
          </>
        )}
        {!narrow && (
          <>
            <text className="t-xs w7 f-ink2" x={X(slowest) + 10} y={Y(4) + 5}>
              slowest {slowest.toFixed(1)} s
            </text>
            <text className="t-xs w7 f-ink2" x={X(fastest) - 10} y={Y(4) - 9} textAnchor="end">
              fastest {fastest.toFixed(1)} s
            </text>
            {replayed && (
              <text className="t-xs w8 f-P" x={X((replayed.marks.included as number) / 1000) + 8} y={Y(4) + 22}>
                replayed {((replayed.marks.included as number) / 1000).toFixed(1)} s
              </text>
            )}
          </>
        )}
      </svg>
    </div>
  );
}
