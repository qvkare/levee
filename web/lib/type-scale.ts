/**
 * The type scale, for drawings that size boxes around their own text. The same numbers are the
 * --t-* tokens in app/globals.css, and a test holds the two together. DESIGN.md allows six sizes
 * plus display.
 */
export const TYPE = { xs: 13, s: 15, m: 17, l: 20, code: 30 } as const;

/** clamp(min, vw, max) as CSS works it out, for a viewport `width` pixels wide. */
export interface Fluid {
  min: number;
  vw: number;
  max: number;
}

export const HEADING: Fluid = { min: 32, vw: 3.4, max: 48 };
export const DISPLAY: Fluid = { min: 38, vw: 4.1, max: 58 };

export function fluid({ min, vw, max }: Fluid, width: number): number {
  return Math.min(max, Math.max(min, (vw / 100) * width));
}

export const fluidCss = ({ min, vw, max }: Fluid) => `clamp(${min}px, ${vw}vw, ${max}px)`;
