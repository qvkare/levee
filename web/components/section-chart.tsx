import { BED_Y, CREST_Y, OVERTOP_Y, chartY, spreadLabels, staffTicks } from "@/lib/gauge.ts";
import { approxFall } from "@/lib/math.ts";
import type { ChartModel } from "@/lib/reading.ts";
import { Hatch } from "./hatch.tsx";

/** Percent of chart height that the staff plate starts and ends at. */
const STAFF_TOP = 3;
const STAFF_BOTTOM = 97;
const onStaff = (y: number) => ((y - STAFF_TOP) / (STAFF_BOTTOM - STAFF_TOP)) * 100;

/** Minimum gap between labels, as a percent of chart height. */
const LABEL_GAP = 8;

const TICKS = staffTicks();
const LEVEE_PROFILE = `0,${BED_Y} 34,${CREST_Y} 54,${CREST_Y} 80,46 100,46 100,${BED_Y}`;

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

export function SectionChart({ model, target, label }: { model: ChartModel; target: number | null; label: string }) {
  const { state, waterFall, marks, summary } = model;
  const over = state === "over";
  const waterY = over ? OVERTOP_Y : waterFall === null ? null : chartY(waterFall);
  const heights = marks.map((mark) => chartY(mark.fall));
  const labels = spreadLabels(over ? heights.map((y) => Math.max(y, OVERTOP_Y)) : heights, LABEL_GAP);

  return (
    <figure className="section" aria-label={label}>
      <div className="chart" data-state={state} role="img" aria-label={summary}>
        {waterY !== null && <div className="chart-water" style={{ top: `${waterY}%` }} />}
        <svg className="chart-levee" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <polygon points={LEVEE_PROFILE} />
        </svg>
        <span className="chart-levee-name" aria-hidden="true">
          Levee
        </span>
        <div className="chart-ground" />
        <div className="chart-flood" style={{ top: `${CREST_Y}%` }}>
          <span>{over ? "Over flood stage" : "Flood stage 1.00"}</span>
        </div>
        <Staff />
        {state === "out" && <Hatch className="chart-hatch" />}
        {state === "out" && <p className="chart-empty water-label">Gauge out of service</p>}
        {state === "dry" && <p className="chart-empty water-label">Dry channel</p>}
        {target !== null && state !== "out" && state !== "dry" && (
          <>
            <div className="chart-target" style={{ transform: `translateY(${chartY(approxFall(target))}%)` }} aria-hidden="true">
              <i />
            </div>
            <div className="chart-target-label" style={{ transform: `translateY(${chartY(approxFall(target))}%)` }} aria-hidden="true">
              <span className="water-label">Target {target.toFixed(2)}</span>
            </div>
          </>
        )}
        {marks.length > 0 && (
          <svg className="chart-leaders" viewBox="0 0 16 100" preserveAspectRatio="none" aria-hidden="true">
            {marks.map((mark, index) => (
              <line key={mark.id} x1="0" y1={heights[index]} x2="16" y2={(labels[index] as number) + 1.6} />
            ))}
          </svg>
        )}
        {marks.map((mark, index) => (
          <p key={mark.id} className="chart-mark water-label" style={{ top: `${labels[index]}%` }}>
            {mark.name} {mark.value}
          </p>
        ))}
      </div>
    </figure>
  );
}
