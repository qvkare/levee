/**
 * Geometry of the section chart. Height runs from the crest (no fall left) down to the bed.
 * Spacing follows the square root of the fall, so the last few percent above flood stage get
 * the most room, the way a rating curve spreads low stages on log paper.
 */
import { approxFall } from "./math.ts";

/** Health factor 5. Below this the water is on the bed. */
export const STAFF_MAX_FALL = 0.8;

/** Percent of chart height. */
export const CREST_Y = 18;
export const BED_Y = 97;
/** Water level when it is over the crest. */
export const OVERTOP_Y = 6;

export function chartY(fall: number): number {
  const clamped = Math.min(STAFF_MAX_FALL, Math.max(0, fall));
  return CREST_Y + (BED_Y - CREST_Y) * Math.sqrt(clamped / STAFF_MAX_FALL);
}

export interface StaffTick {
  y: number;
  major: boolean;
  stage: string | null;
  fall: string | null;
}

const LABELS = new Set([1, 1.05, 1.1, 1.25, 1.5, 2, 3, 5]);

function tickValues(): number[] {
  const values: number[] = [];
  for (let h = 100; h < 110; h += 1) values.push(h / 100);
  for (let h = 110; h < 200; h += 5) values.push(h / 100);
  for (let h = 200; h <= 500; h += 25) values.push(h / 100);
  return values;
}

/** Marks on both faces of the staff: stage on one, the same height as approximate fall on the other. */
export function staffTicks(): StaffTick[] {
  return tickValues().map((health) => {
    const fall = approxFall(health);
    const labelled = LABELS.has(health);
    return {
      y: chartY(fall),
      major: labelled,
      stage: labelled ? health.toFixed(2) : null,
      fall: labelled ? `${Math.round(fall * 100)}%` : null,
    };
  });
}

/** Spreads labels that would overlap, keeping order. Leaders still point at the true height. */
export function spreadLabels(ys: number[], minGap: number, limit = BED_Y - minGap / 2): number[] {
  const order = ys.map((y, index) => ({ y, index })).sort((a, b) => a.y - b.y);
  const placed: number[] = [];
  order.forEach(({ y }, i) => {
    placed.push(i === 0 ? y : Math.max(y, (placed[i - 1] as number) + minGap));
  });
  for (let i = placed.length - 1, ceiling = limit; i >= 0; i -= 1) {
    placed[i] = Math.min(placed[i] as number, ceiling);
    ceiling = (placed[i] as number) - minGap;
  }
  const result = new Array<number>(ys.length);
  order.forEach(({ index }, i) => {
    result[index] = placed[i] as number;
  });
  return result;
}
