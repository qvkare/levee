"use client";

import { useMemo, type ReactNode } from "react";
import { readDate } from "@/lib/format.ts";
import { fitsHome, type HomeReading } from "@/lib/home-reading-rules.ts";
import { verdict } from "@/lib/reading.ts";
import { buildWall, offAxisLine, rowFor, unreadLine } from "@/lib/wall.ts";
import { SiteHeader } from "./site-header.tsx";
import { useReading, type Phase } from "./use-reading.ts";
import { Axis, Run } from "./wall.tsx";

function sourceLine(source: HomeReading["source"], fresh: boolean, phase: Phase, generatedAt: string): string {
  const date = readDate(generatedAt);
  if (fresh) return `Shown: one public borrower, read ${date}.`;
  if (source === "example") return `Example, not live: one public borrower as stored on ${date}, because no live read could be used.`;
  if (phase === "failed" || phase === "limited") return `Example, not live: one public borrower as read on ${date}, because the live read failed.`;
  return `Shown: one public borrower, read ${date}.`;
}

/** The first screen. The HTML holds a reading from the build, and the browser replaces it with a live one. */
export function HomeWall({ reading, children }: { reading: HomeReading; children: ReactNode }) {
  const { report, phase, fresh } = useReading(reading.report, { live: true, readOnMount: true, accept: fitsHome });
  const wall = useMemo(() => buildWall(report), [report]);
  const rows = wall.onAxis.map((entry) => rowFor(entry, "home"));
  const off = offAxisLine(wall, "home");
  const unread = unreadLine(wall);

  return (
    <>
      <SiteHeader shown={report.address} />
      <main id="main">
        <p className="vh" role="status">
          {verdict(report).text}
        </p>
        <div className="board board-full">
          <Run rows={rows} label="Positions at one public address, nearest to liquidation first" />
          {(off || unread) && (
            <div className="under">
              <p>
                {off}
                {off && unread ? " " : ""}
                {unread}
              </p>
            </div>
          )}
          <div className="claim">
            <h1>Every position at an address, in the order it would go.</h1>
            <p>
              No wallet and no login. Reads Aave on Base and Arbitrum, and Hyperliquid. {sourceLine(reading.source, fresh, phase, report.generatedAt)} The order is percentage move in price, not likelihood. <b>Levee is unaudited.</b>
            </p>
          </div>
          <Axis />
        </div>
        {children}
      </main>
    </>
  );
}
