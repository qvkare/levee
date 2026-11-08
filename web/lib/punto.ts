/**
 * The one rule behind the page: type size in pixels is 2520 divided by the distance from the wall
 * in percent, held between 15 and 208. Nothing else sets the size of a number on the wall.
 *
 * The rule itself lives in CSS, so the page holds up with no script: see --k in globals.css. Phone
 * and tablet use a smaller k, because the page is narrower. This copy decides how much label a row
 * has room for, and keeps the two honest through a test.
 */
export const PUNTO_K = 2520;
export const PUNTO_MIN = 15;
export const PUNTO_MAX = 208;

export function punto(distancePercent: number): number {
  if (distancePercent <= 0) return PUNTO_MAX;
  return Math.min(PUNTO_MAX, Math.max(PUNTO_MIN, PUNTO_K / distancePercent));
}

/** large: a name and two lines. mid: a name and one. small: one line in all. */
export type Tier = "large" | "mid" | "small";

export function tierFor(distancePercent: number): Tier {
  const size = punto(distancePercent);
  if (size >= 120) return "large";
  return size >= 44 ? "mid" : "small";
}
