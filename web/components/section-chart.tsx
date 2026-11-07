import { OVERTOP_Y, chartY, spreadLabels } from "@/lib/gauge.ts";
import { approxFall } from "@/lib/math.ts";
import type { ChartModel } from "@/lib/reading.ts";
import { Hatch } from "./hatch.tsx";
import { RiverSection } from "./river-section.tsx";

/** Minimum gap between labels, as a percent of chart height. */
const LABEL_GAP = 8;

/** The report's section: every venue marked on one staff, with the nearest reading as the water. */
export function SectionChart({ model, target, label }: { model: ChartModel; target: number | null; label: string }) {
  const { state, waterFall, marks, summary } = model;
  const over = state === "over";
  const waterY = over ? OVERTOP_Y : waterFall === null ? null : chartY(waterFall);
  const heights = marks.map((mark) => chartY(mark.fall));
  const labels = spreadLabels(heights, LABEL_GAP);
  const lines = target !== null && state !== "out" && state !== "dry" ? [{ id: "target", y: chartY(approxFall(target)), label: `Target ${target.toFixed(2)}` }] : [];

  return (
    <figure aria-label={label}>
      <RiverSection state={state} waterY={waterY} lines={lines} summary={summary}>
        {state === "out" && <Hatch className="chart-hatch" />}
        {state === "out" && <p className="chart-empty water-label">Gauge out of service</p>}
        {state === "dry" && <p className="chart-empty water-label">Dry channel</p>}
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
      </RiverSection>
    </figure>
  );
}
