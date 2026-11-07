import { Fragment, type ReactNode } from "react";
import { BED_Y, CREST_Y, staffTicks } from "@/lib/gauge.ts";
import type { ChartState } from "@/lib/reading.ts";

/** Percent of chart height that the staff plate starts and ends at. */
const STAFF_TOP = 3;
const STAFF_BOTTOM = 97;
const onStaff = (y: number) => ((y - STAFF_TOP) / (STAFF_BOTTOM - STAFF_TOP)) * 100;

const TICKS = staffTicks();
const LEVEE_PROFILE = `0,${BED_Y} 34,${CREST_Y} 54,${CREST_Y} 80,46 100,46 100,${BED_Y}`;

export interface LevelLine {
  id: string;
  /** Percent of chart height. */
  y: number;
  label: string;
}

function Staff() {
  return (
    <div className="chart-staff" aria-hidden="true">
      <span className="staff-head" data-face="stage">
        Stage
      </span>
      <span className="staff-head" data-face="fall">
        Fall
      </span>
      {TICKS.map((tick) => (
        <i key={tick.y} className="staff-tick" data-major={tick.major} style={{ top: `${onStaff(tick.y)}%` }} />
      ))}
      {TICKS.filter((tick) => tick.stage).map((tick) => (
        <span key={tick.y}>
          <span className="staff-number" data-face="stage" style={{ top: `${onStaff(tick.y)}%` }}>
            {tick.stage}
          </span>
          <span className="staff-number" data-face="fall" style={{ top: `${onStaff(tick.y)}%` }}>
            {tick.fall}
          </span>
        </span>
      ))}
    </div>
  );
}

/**
 * Levee's own drawing: a river section with a staff, a bank and a flood line at the crest. The water
 * is one flat tint, and everything that moves does so by transform.
 */
export function RiverSection({
  state,
  waterY,
  lines = [],
  fit = "page",
  summary,
  children,
}: {
  state: ChartState;
  /** Percent of chart height. Null draws no water. */
  waterY: number | null;
  lines?: LevelLine[];
  fit?: "page" | "column";
  /** Spoken description of the drawing. */
  summary: string;
  children?: ReactNode;
}) {
  return (
    <div className="chart" data-state={state} data-fit={fit} role="img" aria-label={summary}>
      {waterY !== null && <div className="chart-water" style={{ transform: `translateY(${waterY}%)` }} />}
      <svg className="chart-levee" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <polygon points={LEVEE_PROFILE} />
      </svg>
      <span className="chart-levee-name" aria-hidden="true">
        Levee
      </span>
      <div className="chart-ground" />
      <div className="chart-flood" style={{ top: `${CREST_Y}%` }}>
        <span>{state === "over" ? "Over flood stage" : "Flood stage 1.00"}</span>
      </div>
      <Staff />
      {lines.map((line) => (
        <Fragment key={line.id}>
          <div className="chart-target" style={{ transform: `translateY(${line.y}%)` }} aria-hidden="true">
            <i />
          </div>
          <div className="chart-target-label" style={{ transform: `translateY(${line.y}%)` }} aria-hidden="true">
            <span className="water-label">{line.label}</span>
          </div>
        </Fragment>
      ))}
      {children}
    </div>
  );
}
