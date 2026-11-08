"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SCHEMA, type RiskReport } from "@/lib/types.ts";

/** idle: the last read worked. failed: no usable answer. limited: this connection read too often. */
export type Phase = "idle" | "reading" | "failed" | "limited";

interface Options {
  /** A simulation stays as it is. */
  live: boolean;
  /** Read as soon as the page is up, because the HTML is older than this visit. */
  readOnMount?: boolean;
  /** A reading the page should not swap in. It counts as a failed read. */
  accept?: (report: RiskReport) => boolean;
  everyMs?: number;
}

/**
 * Keeps a report fresh in the browser. A failed read keeps the last good reading on the page, and
 * the phase says so. A hidden tab does not poll.
 */
export function useReading(initial: RiskReport, { live, readOnMount = false, accept, everyMs = 60_000 }: Options) {
  const [report, setReport] = useState(initial);
  const [phase, setPhase] = useState<Phase>("idle");
  const [fresh, setFresh] = useState(false);
  const acceptRef = useRef(accept);
  acceptRef.current = accept;

  const read = useCallback(async () => {
    setPhase("reading");
    try {
      const response = await fetch(`/api/risk?address=${initial.address}`);
      if (response.status === 429) {
        setPhase("limited");
        return;
      }
      const next = (await response.json()) as RiskReport;
      const usable = response.ok && next.schema === SCHEMA && next.status !== "unavailable" && (acceptRef.current?.(next) ?? true);
      if (!usable) {
        setPhase("failed");
        return;
      }
      setReport(next);
      setFresh(true);
      setPhase("idle");
    } catch {
      setPhase("failed");
    }
  }, [initial.address]);

  useEffect(() => {
    if (!live) return;
    if (readOnMount) void read();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void read();
    }, everyMs);
    return () => clearInterval(timer);
  }, [live, readOnMount, read, everyMs]);

  return { report, phase, fresh, read };
}
