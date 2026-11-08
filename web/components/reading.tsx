"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { shortAddress } from "@/lib/address.ts";
import { clock, integer, percent } from "@/lib/format.ts";
import { buildLine, crisisFor, figuresFor, pointsFor, readingLine, unplacedLine, unreadLine, type DistanceLine as Line, type LineEntry } from "@/lib/line.ts";
import { MAX_TARGET, MIN_TARGET } from "@/lib/math.ts";
import { verdict } from "@/lib/reading.ts";
import { withTarget } from "@/lib/report.ts";
import type { RiskReport } from "@/lib/types.ts";
import { MAX_FALL_PERCENT, type WhatIf } from "@/lib/what-if.ts";
import { AddressForm } from "./address-form.tsx";
import { Badge } from "./badge.tsx";
import { CrisisBand } from "./crisis.tsx";
import { DistanceLine } from "./distance-line.tsx";
import { FiguresTable } from "./figures-table.tsx";
import { Holdings } from "./holdings.tsx";
import { LeveeNote, type Measured } from "./levee-note.tsx";
import { useReading, type Phase } from "./use-reading.ts";

/** A source's own message, less the closing line every failure shares. The unread line says that once. */
// Matches the API's own wording so it can be removed from the page.
const cleaned = (message: string) => message.replace(/\s*[\w ]+ figures are missing, not zero\.$/, "").trim();

function headline(line: Line, report: RiskReport, simulated: boolean): string {
  if (report.status === "unavailable") return "No source answered";
  const first = line.placed[0];
  if (!first) return "Nothing here can be liquidated";
  if (first.distance === 0) return `${first.name} can be liquidated now`;
  return `${first.name} ${simulated ? "would be" : "is"} ${percent(first.distance ?? 0)} from liquidation`;
}

function phaseLine(phase: Phase): string | null {
  if (phase === "failed") return "The last read failed. These are the figures before it.";
  if (phase === "limited") return "This connection has read too often. These are the last figures.";
  return null;
}

function simulationLine(whatIf: WhatIf): string {
  const block = whatIf.blockNumber ? ` read at block ${integer(whatIf.blockNumber)}` : " as read";
  return `This position’s real terms, with ${whatIf.asset} ${percent(whatIf.fall)} below the price${block}. Everything else is as read.`;
}

/** Which sources did not answer, or answered in part. */
function Missing({ report, line }: { report: RiskReport; line: Line }) {
  const unread = unreadLine(line);
  const messages = [...new Set(report.failures.map((failure) => cleaned(failure.message)).filter(Boolean))];
  if (!unread && messages.length === 0) return null;
  return (
    <div className="notice" role="note">
      <Badge lane="K" size="s" />
      <div>
        <p>
          <b>{report.status === "unavailable" ? "Nothing was read." : "Part of this reading is missing."}</b> {unread}
        </p>
        {messages.length > 0 && (
          <ul>
            {messages.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Legend({ trigger }: { trigger: number | null }) {
  return (
    <ul className="legend" aria-label="Key">
      <li>
        <i className="c-P" aria-hidden="true" />
        Levee can repay
      </li>
      <li>
        <i className="c-I" aria-hidden="true" />
        Levee cannot reach it
      </li>
      {trigger !== null && (
        <li>
          <i className="key-band" aria-hidden="true" />
          Under trigger {trigger.toFixed(2)}, the testnet runs’ trigger
        </li>
      )}
    </ul>
  );
}

function Tools({ address, target, onTarget, fall, canSimulate }: { address: string; target: number; onTarget: (value: number) => void; fall: number | null; canSimulate: boolean }) {
  return (
    <div className="tools">
      <label className="tool">
        Repay target
        <input type="number" inputMode="decimal" min={MIN_TARGET} max={MAX_TARGET} step={0.05} defaultValue={target.toFixed(2)} onChange={(event) => onTarget(Number(event.target.value))} />
      </label>
      {canSimulate && (
        <form className="tool" action={`/a/${address}`} method="get">
          <label htmlFor="fall">Simulate a fall in collateral, %</label>
          <span className="tool-row">
            <input id="fall" name="fall" type="number" inputMode="decimal" min={0.1} max={MAX_FALL_PERCENT} step={0.1} defaultValue={fall === null ? undefined : (fall * 100).toFixed(1)} required />
            <input type="hidden" name="target" value={target.toFixed(2)} />
            <button className="button" type="submit">
              Run it
            </button>
          </span>
        </form>
      )}
    </div>
  );
}

interface Props {
  report: RiskReport;
  whatIf: WhatIf | null;
  trigger: number | null;
  measured: Measured;
}

/** A reading of one address: the answer, the line, then every figure. All of it renders on the server first. */
export function Reading({ report: initial, whatIf, trigger, measured }: Props) {
  const [target, setTarget] = useState(initial.target);
  const [leaving, setLeaving] = useState<string | null>(null);
  const { report: read, phase, fresh, read: readAgain } = useReading(initial, { live: whatIf === null });
  const report = useMemo(() => withTarget(read, target), [read, target]);
  const line = useMemo(() => buildLine(report), [report]);
  const points = useMemo(() => pointsFor(line), [line]);
  const crisis = crisisFor(line);
  const reading = phase === "reading";
  const late = phaseLine(phase);
  const unplaced = unplacedLine(line);
  const answer = verdict(report).text;
  const firstHasRepay = line.entries.some((entry) => entry.kind === "aave" && entry.distance !== null);
  const busy = leaving !== null || reading;

  function chooseTarget(value: number) {
    if (!Number.isFinite(value) || value < MIN_TARGET || value > MAX_TARGET) return;
    setTarget(value);
    // Keeps the chosen target in the link, so a shared page opens the same way.
    const url = new URL(window.location.href);
    url.searchParams.set("target", value.toFixed(2));
    window.history.replaceState(null, "", url);
  }

  const again = whatIf ? (
    <Link href={`/a/${report.address}`} prefetch={false}>
      Back to the live reading
    </Link>
  ) : (
    <button className="text-button" type="button" onClick={() => void readAgain()} disabled={reading}>
      {reading ? "Reading" : "Read again"}
    </button>
  );

  // In the last 5% the band above says what was simulated, so this line says it only outside it.
  const when = whatIf ? (
    crisis ? (
      "Simulated from a live reading"
    ) : (
      <>
        <b>Simulation.</b> {simulationLine(whatIf)}
      </>
    )
  ) : (
    `Read ${clock(report.generatedAt)}`
  );

  const lead: ReactNode = whatIf ? (
    <>
      <b>Simulation.</b> {simulationLine(whatIf)}
    </>
  ) : (
    <>
      <b>Live reading.</b> {crisis && line.crisis ? readingLine(line.crisis as LineEntry, report) : ""} {late}
    </>
  );

  return (
    <main id="main" data-reading={busy || undefined} aria-busy={busy || undefined}>
      <p className="vh" role="status">
        {leaving ? `Reading ${leaving}.` : fresh ? `New reading at ${clock(report.generatedAt)}. ${answer}` : ""}
      </p>
      {crisis && (
        <div className="result">
          <CrisisBand model={crisis} distance={line.crisis?.distance ?? 0} lead={lead}>
            <p>{again}</p>
          </CrisisBand>
        </div>
      )}
      <div className="read-top">
        <div className="result">
          {!crisis && <h1>{headline(line, report, whatIf !== null)}</h1>}
          <p className="who-line">
            <span className="tag">{whatIf ? "Simulation" : "Reading"}</span>
            <span className="mono">{report.address}</span>
          </p>
          <p className="lede">{answer}</p>
          <p className="who-line">
            <span>{when}</span>
            {!crisis && again}
            <a href={`/api/risk?address=${report.address}&target=${target.toFixed(2)}`}>JSON</a>
          </p>
          {late && !crisis && <p className="who-line">{late}</p>}
        </div>
        <AddressForm title="Check another address" value={report.address} onRead={(address) => setLeaving(shortAddress(address))} />
      </div>
      <p className="reading-now read-pad" aria-hidden="true">
        {leaving ? `Reading ${leaving}` : "Reading again"}
      </p>
      <div className="result">
        <section className="read-band" aria-labelledby="line-h">
          <div className="band-head">
            <h2 id="line-h">Distance to liquidation</h2>
            <p className="band-meta">Each position by the move that would liquidate it, on a square-root scale. Nearest first.</p>
          </div>
          <Missing report={report} line={line} />
          <DistanceLine points={points} trigger={trigger} crisisId={line.crisis?.id ?? null} empty={report.status === "unavailable" ? "No source answered" : "No position to place"} />
          {points.length > 0 && <Legend trigger={trigger} />}
          {unplaced && <p className="note-line">{unplaced}</p>}
          {points.length > 0 && <p className="note-line">Distances are percentage moves in price. They are not likelihoods.</p>}
        </section>

        {line.entries.length > 0 && (
          <section className="s s-tight" aria-labelledby="figures-h">
            <h2 className="big" id="figures-h">
              Every figure
            </h2>
            <Tools address={report.address} target={target} onTarget={chooseTarget} fall={whatIf?.fall ?? null} canSimulate={firstHasRepay} />
            <FiguresTable rows={figuresFor(line, report)} target={target.toFixed(2)} />
            <Holdings report={report} />
            <p className="note-line">
              The same data is at <a href={`/api/risk?address=${report.address}&target=${target.toFixed(2)}`}>/api/risk</a> as JSON, with the exact contract outputs and the block number, so any figure here can be repeated with a direct call.
            </p>
          </section>
        )}

        {report.status !== "unavailable" && (
          <section className="s s-tint s-tight" aria-label="What Levee would do">
            <LeveeNote first={line.placed[0]} measured={measured} />
            <p className="note-line">Levee has no relationship with this address. Aave distances are approximate falls in collateral against debt.</p>
          </section>
        )}
      </div>
    </main>
  );
}
