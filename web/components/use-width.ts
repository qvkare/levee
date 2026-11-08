"use client";

import { useEffect, useRef, useState } from "react";

/** Phone layout. The stylesheet switches at the same width. */
export const NARROW = "(max-width: 820px)";

export interface Measure {
  /** The element's width in pixels. */
  width: number;
  /** The window's width, for the fluid type sizes. */
  viewport: number;
  narrow: boolean;
  /** False until the browser has measured. The server draws with the fallbacks. */
  measured: boolean;
}

/**
 * The drawings set their own coordinates from the width they get, so text keeps its size. The server
 * draws at a stated width, and the browser redraws at the real one as soon as it has it.
 */
export function useWidth<T extends HTMLElement>(fallback: { width: number; viewport: number; narrow: boolean }) {
  const ref = useRef<T>(null);
  const [measure, setMeasure] = useState<Measure>({ ...fallback, measured: false });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const media = window.matchMedia(NARROW);
    const update = () => {
      const width = Math.round(element.getBoundingClientRect().width);
      if (width > 0) setMeasure({ width, viewport: window.innerWidth, narrow: media.matches, measured: true });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    media.addEventListener("change", update);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", update);
    };
  }, []);

  return { ref, ...measure };
}

/** The reader asked for less motion. */
export const LESS_MOTION = "(prefers-reduced-motion: reduce)";
