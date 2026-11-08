"use client";

import Link from "next/link";
import { useMemo } from "react";
import { readDate } from "@/lib/format.ts";
import { fitsHome, type HomeReading } from "@/lib/home-reading-rules.ts";
import { buildLine, directionSentence, pointsFor, triggerSentence } from "@/lib/line.ts";
import { DistanceLine } from "./distance-line.tsx";
import { useReading, type Phase } from "./use-reading.ts";

function sourceLine(source: HomeReading["source"], fresh: boolean, phase: Phase, generatedAt: string): string {
  const date = readDate(generatedAt);
  if (fresh) return `read ${date}`;
  if (source === "example") return `stored ${date}, because no live read could be used`;
  if (phase === "failed" || phase === "limited") return `read ${date}, and the live read failed`;
  return `read ${date}`;
}

/** The home page's example: a real reading from the build, read again live in the browser. */
export function ReadSection({ reading, trigger }: { reading: HomeReading; trigger: number | null }) {
  const { report, phase, fresh } = useReading(reading.report, { live: true, readOnMount: true, accept: fitsHome });
  const line = useMemo(() => buildLine(report), [report]);
  const points = useMemo(() => pointsFor(line), [line]);
  const under = triggerSentence(line, trigger);

  return (
    <section className="s" id="read" aria-labelledby="read-h">
      <div className="sh">
        <h2 className="big" id="read-h">
          Read any address
        </h2>
        <p>Free and read-only. Levee reads Aave on Base and Arbitrum, and Hyperliquid, and places each position on one line by its distance from liquidation. It repays only on Aave.</p>
      </div>
      <p className="rd-meta" aria-live="polite">
        <span className="tag">Example</span>
        <Link className="mono rd-address" href={`/a/${report.address}`} prefetch={false}>
          {report.address}
        </Link>
        <span>{sourceLine(reading.source, fresh, phase, report.generatedAt)} · distance on a square-root scale</span>
      </p>
      <DistanceLine points={points} trigger={trigger} />
      <div className="rd-foot">
        {under && (
          <p>
            <b>{under.strong}</b>
            {under.rest}
          </p>
        )}
        <p>{directionSentence(report)}</p>
      </div>
    </section>
  );
}
