"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { BRIEF } from "@/lib/brief.ts";
import { clock, integer, percent } from "@/lib/format.ts";
import { MAX_TARGET, MIN_TARGET } from "@/lib/math.ts";
import { verdict } from "@/lib/reading.ts";
import { withTarget } from "@/lib/report.ts";
import type { RiskReport } from "@/lib/types.ts";
import { buildWall, crisisFor, debtAssets, figuresFor, offAxisLine, readingLine, rowFor, unreadLine, type AaveEntry, type Wall } from "@/lib/wall.ts";
import { MAX_FALL_PERCENT, type WhatIf } from "@/lib/what-if.ts";
import { BacktestBrief } from "./backtest-brief.tsx";
import { CrisisView } from "./crisis.tsx";
import { FiguresTable } from "./figures-table.tsx";
import { Holdings } from "./holdings.tsx";
import { LeveeNote } from "./levee-note.tsx";
import { BareHeader, SiteHeader } from "./site-header.tsx";
import { useReading, type Phase } from "./use-reading.ts";
import { Axis, Run } from "./wall.tsx";

const ORDER_NOTE = "Distances are percentage moves in price, not likelihoods.";

function simulationLine(whatIf: WhatIf): string {
  const block = whatIf.blockNumber ? ` read at block ${integer(whatIf.blockNumber)}` : " as read";
  return `This position's real terms, with ${whatIf.asset} ${percent(whatIf.fall)} below the price${block}. Everything else is as read.`;
}

function phaseLine(phase: Phase): string | null {
  if (phase === "failed") return "The last read failed. These are the figures before it.";
  if (phase === "limited") return "This connection has read too often. These are the last figures.";
  return null;
}

/** Non-USDC debt. Levee has no way to act on it, so the wall says that before anything else. */
function Unpayable({ entries }: { entries: AaveEntry[] }) {
  const first = entries[0] as AaveEntry;
  const assets = debtAssets(first.position);
  return (
    <section className="barred" aria-labelledby="unpayable">
      <h2 id="unpayable">Levee cannot repay this debt.</h2>
      <p>
        {entries.length === 1 ? `The debt on ${first.name.replace("Aave on ", "")} is ${assets}.` : "These debts are not USDC."} Levee repays USDC variable debt on Aave, and {entries.length === 1 ? "this position has none" : "these positions have none"}, so a reserve, a trigger and a keeper would
        change nothing here. An outlined number is a position Levee cannot reach.
      </p>
      {first.position.dropToLiquidation?.note && <p>{first.position.dropToLiquidation.note}</p>}
    </section>
  );
}

function Tools({ address, target, onTarget, fall, canSimulate }: { address: string; target: number; onTarget: (value: number) => void; fall: number | null; canSimulate: boolean }) {
  return (
    <div className="tools">
      <h2>The same order, every figure.</h2>
      <label className="tool">
        Repay target
        <input type="number" inputMode="decimal" min={MIN_TARGET} max={MAX_TARGET} step={0.05} defaultValue={target.toFixed(2)} onChange={(event) => onTarget(Number(event.target.value))} />
      </label>
      {canSimulate && (
        <form className="tool" action={`/a/${address}`} method="get">
          <label htmlFor="fall">Simulate a fall, %</label>
          <input id="fall" name="fall" type="number" inputMode="decimal" min={0.1} max={MAX_FALL_PERCENT} step={0.1} defaultValue={fall === null ? undefined : (fall * 100).toFixed(1)} required />
          <input type="hidden" name="target" value={target.toFixed(2)} />
          <button className="button" type="submit">
            Run it
          </button>
        </form>
      )}
    </div>
  );
}

function Rest({ report, wall, target, onTarget, whatIf, firstHasRepay }: { report: RiskReport; wall: Wall; target: number; onTarget: (value: number) => void; whatIf: WhatIf | null; firstHasRepay: boolean }) {
  // The band above already says these.
  const said = wall.entries.flatMap((entry) => (entry.kind === "aave" && entry.reach === "none" ? (entry.position.dropToLiquidation?.note ?? []) : []));
  return (
    <>
      {wall.entries.length > 0 && (
        <section className="sec" aria-label="Every figure">
          <Tools address={report.address} target={target} onTarget={onTarget} fall={whatIf?.fall ?? null} canSimulate={firstHasRepay} />
          <FiguresTable rows={figuresFor(wall, report)} target={target.toFixed(2)} />
          <Holdings report={report} quiet={said} />
          <p className="note">
            The same data is at <a href={`/api/risk?address=${report.address}&target=${target.toFixed(2)}`}>/api/risk</a> as JSON, with the exact contract outputs and the block number, so any figure here can be repeated with a direct call.
          </p>
        </section>
      )}
      <section className={wall.entries.length > 0 ? "more" : "more more-top"} aria-label="What Levee does">
        <LeveeNote first={wall.entries[0]} />
        {BRIEF.backtest && <BacktestBrief />}
      </section>
      <div className="page-note">
        <p>Levee has no relationship with this address.</p>
        <p>Aave distances are approximate falls in collateral against debt.</p>
      </div>
    </>
  );
}

/** The wall for one address, then every figure in the same order. All of it renders on the server first. */
export function LiveReport({ report: initial, whatIf }: { report: RiskReport; whatIf: WhatIf | null }) {
  const [target, setTarget] = useState(initial.target);
  const { report: read, phase, fresh, read: readAgain } = useReading(initial, { live: whatIf === null });
  const report = useMemo(() => withTarget(read, target), [read, target]);
  const wall = useMemo(() => buildWall(report), [report]);
  const crisis = crisisFor(wall);
  const rows = wall.onAxis.map((entry) => rowFor(entry, "report"));
  const unpayable = wall.entries.filter((entry): entry is AaveEntry => entry.kind === "aave" && entry.reach === "none");
  const firstHasRepay = wall.entries.some((entry) => entry.kind === "aave" && entry.distance !== null);
  const reading = phase === "reading";
  const late = phaseLine(phase);
  const off = offAxisLine(wall, "report");
  const unread = unreadLine(wall);
  const answer = verdict(report).text;

  function chooseTarget(value: number) {
    if (!Number.isFinite(value) || value < MIN_TARGET || value > MAX_TARGET) return;
    setTarget(value);
    // Keeps the chosen target in the link, so a shared page opens the same way.
    const url = new URL(window.location.href);
    url.searchParams.set("target", value.toFixed(2));
    window.history.replaceState(null, "", url);
  }

  const status = (
    <p className="vh" role="status">
      {fresh ? `New reading at ${clock(report.generatedAt)}. ` : ""}
      {answer}
    </p>
  );

  if (crisis && wall.crisis) {
    return (
      <>
        <BareHeader>
          {whatIf ? (
            <Link href={`/a/${report.address}`} prefetch={false}>
              Back to the live reading
            </Link>
          ) : (
            <button type="button" onClick={() => void readAgain()} disabled={reading}>
              {reading ? "Reading" : "Read again"}
            </button>
          )}
        </BareHeader>
        <main id="main" data-crisis="on">
          {status}
          <CrisisView
            model={crisis}
            lead={
              whatIf ? (
                <>
                  <b>Simulation.</b> {simulationLine(whatIf)}
                </>
              ) : (
                <>
                  <b>Live reading.</b> {[readingLine(wall.crisis, report), unread, late].filter(Boolean).join(" ")}
                </>
              )
            }
          />
          {unpayable.length > 0 && <Unpayable entries={unpayable} />}
          <Rest report={report} wall={wall} target={target} onTarget={chooseTarget} whatIf={whatIf} firstHasRepay={firstHasRepay} />
        </main>
      </>
    );
  }

  return (
    <>
      <SiteHeader value={report.address} />
      <main id="main">
        {status}
        <div className="board">
          {report.status === "unavailable" ? (
            <div className="empty">
              <h1 className="lead-title">No source answered.</h1>
              <p>Aave on Base, Aave on Arbitrum and Hyperliquid all failed to answer, so nothing can be said about this address yet. Missing is not zero.</p>
              <p>
                <button className="text-button" type="button" onClick={() => void readAgain()} disabled={reading}>
                  {reading ? "Reading" : "Read again"}
                </button>
              </p>
            </div>
          ) : wall.entries.length === 0 ? (
            <div className="empty">
              <h1 className="lead-title">Nothing at this address can be liquidated.</h1>
              <p>{answer}</p>
              {unread && <p>{unread}</p>}
            </div>
          ) : (
            <>
              <h1 className="vh">Positions at {report.address}</h1>
              {whatIf && (
                <p className="under">
                  <span>
                    <b>Simulation.</b> {simulationLine(whatIf)} <Link href={`/a/${report.address}`}>Back to the live reading</Link>
                  </span>
                </p>
              )}
              {rows.length > 0 && <Run rows={rows} label="Positions at this address, nearest to liquidation first" />}
              <div className="under">
                <p>
                  {whatIf ? "Simulation of a reading" : `Read ${clock(report.generatedAt)}`}.{" "}
                  {!whatIf && (
                    <button className="text-button" type="button" onClick={() => void readAgain()} disabled={reading}>
                      {reading ? "Reading" : "Read again"}
                    </button>
                  )}{" "}
                  {late}
                </p>
                <p>
                  {off && (
                    <>
                      {off}
                      <br />
                    </>
                  )}
                  {unread && (
                    <>
                      {unread}
                      <br />
                    </>
                  )}
                  {rows.some((row) => row.hollow) && (
                    <>
                      An outlined number is a position Levee cannot reach.
                      <br />
                    </>
                  )}
                  {ORDER_NOTE}
                </p>
              </div>
            </>
          )}
          <Axis />
        </div>
        {unpayable.length > 0 && <Unpayable entries={unpayable} />}
        <Rest report={report} wall={wall} target={target} onTarget={chooseTarget} whatIf={whatIf} firstHasRepay={firstHasRepay} />
      </main>
    </>
  );
}
