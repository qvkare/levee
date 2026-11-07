import type { Metadata } from "next";
import { Fragment } from "react";
import { MeasuredTable } from "@/components/measured-table.tsx";
import { Num } from "@/components/num.tsx";
import { SiteHeader } from "@/components/site-header.tsx";
import { cssVars } from "@/components/wall.tsx";
import { MISS_MEANINGS, MISS_NAMES, honestFigures, readBacktest, type Backtest, type MissReason } from "@/lib/backtest.ts";
import { CHAIN_NAMES, evmLink, latencyTable, nearLink, percentile, readMpcLatency, readRehearsal, readRuns, tally, type EvidenceRun, type MpcLatency, type Outcome, type Rehearsal, type Tally } from "@/lib/evidence.ts";
import { countWord, dollars, integer, joined, percent, plainShare, seconds, usd } from "@/lib/format.ts";

/** Built once, from the evidence and backtest folders. It must not render on a Worker, which has neither. */
export const dynamic = "force-static";

export const metadata: Metadata = { title: "Proof", description: "Every recorded Levee run, including the aborted one, with explorer links, timings, and the backtest with its misses and limits." };

const OUTCOME_NAMES: Record<Outcome, string> = { success: "Success", failed: "Failed", aborted: "Aborted", unreadable: "Unreadable" };

function RecordLink({ link }: { link: { href: string; label: string } | null }) {
  return link ? (
    <a href={link.href} rel="noreferrer">
      {link.label}
    </a>
  ) : (
    <span className="quiet">none</span>
  );
}

/** USDC has 6 decimals. Amounts are recorded in base units, so this avoids float rounding. */
function usdcAmount(baseUnits: string | null): string {
  if (!baseUnits || !/^\d+$/.test(baseUnits)) return "not recorded";
  if (baseUnits === "0") return "none";
  const padded = baseUnits.padStart(7, "0");
  return `${integer(padded.slice(0, -6))}.${padded.slice(-6, -4)} USDC`;
}

function headline({ total, success, failed, aborted, unreadable }: Tally): string {
  if (total === 0) return "No live runs yet.";
  const parts = [`${success} ${success === 1 ? "rescue" : "rescues"} landed`];
  if (failed) parts.push(`${failed} failed`);
  if (aborted) parts.push(`${aborted} aborted`);
  if (unreadable) parts.push(`${unreadable} unreadable`);
  return `${parts.join(", ")}.`;
}

function scopeLine({ total, chains, positions, testnetOnly }: Tally): string {
  if (total === 0) return "When Levee has run, each run will appear here with its transactions, including the ones that failed.";
  const where = `${joined(chains)}${testnetOnly ? ", a testnet" : ""}`;
  const net = testnetOnly ? " Nothing here has run on a mainnet." : "";
  return `All on ${where}, from ${countWord(positions).toLowerCase()} ${positions === 1 ? "position" : "positions"} on ${countWord(chains.length).toLowerCase()} ${chains.length === 1 ? "chain" : "chains"}.${net} Levee is unaudited. Failed and aborted runs stay on this page.`;
}

function network(run: EvidenceRun): string {
  return run.chainId === null ? "not recorded" : (CHAIN_NAMES[run.chainId] ?? `Chain ${run.chainId}`);
}

function RunsTable({ runs }: { runs: EvidenceRun[] }) {
  return (
    <div className="scroll">
      <table className="prose-table stack-early" role="table" aria-label="Every recorded run, newest first">
        <thead role="rowgroup">
          <tr role="row">
            {["Run", "Outcome", "Chain", "Repaid", "Health before and after", "Detection to inclusion", "NEAR", "Basescan"].map((label) => (
              <th key={label} scope="col" role="columnheader" className={label === "Chain" ? "wide" : undefined}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody role="rowgroup">
          {runs.map((run) => (
            <tr key={run.id} role="row">
              <td role="cell" data-label="Run">
                <code>{run.id}</code>
              </td>
              <td role="cell" data-label="Outcome">
                {OUTCOME_NAMES[run.outcome]}
                {run.failureReason && <small>{run.failureReason}</small>}
              </td>
              <td role="cell" data-label="Chain" className="wide">
                {network(run)}
              </td>
              <td role="cell" data-label="Repaid" className="num">
                <Num>{usdcAmount(run.amount)}</Num>
              </td>
              <td role="cell" data-label="Health before and after" className="num">
                {run.healthBefore ? <Num>{`${run.healthBefore} to ${run.healthAfter ?? "not recorded"}`}</Num> : <span className="quiet">not read</span>}
              </td>
              <td role="cell" data-label="Detection to inclusion" className="num">
                {run.latencyMs === null ? <span className="quiet">none</span> : <Num>{seconds(run.latencyMs)}</Num>}
              </td>
              <td role="cell" data-label="NEAR">
                <RecordLink link={nearLink(run)} />
              </td>
              <td role="cell" data-label="Basescan">
                <RecordLink link={evmLink(run)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Time on the same wall: each moment stands at its true distance from detection. */
function HopStrip({ runs }: { runs: EvidenceRun[] }) {
  const stops = [
    { label: "Rescue call included", where: "NEAR", at: "nearIncluded" },
    { label: "Signature back", where: "MPC network", at: "signed" },
    { label: "Repay sent", where: "Keeper", at: "broadcast" },
    { label: "Repay included", where: "EVM chain", at: "included" },
  ] as const;
  const points = stops.map((stop) => {
    const values = runs.flatMap(({ timestamps }) => {
      const start = timestamps.detected;
      const end = timestamps[stop.at];
      return start !== null && end !== null ? [end - start] : [];
    });
    return { ...stop, ms: percentile(values, 0.5) };
  });
  const longest = Math.max(...points.map((point) => point.ms ?? 0));
  if (longest === 0) return null;
  return (
    <ol className="hops" aria-label="Median time from detection to each moment of a rescue">
      {points.map((point) => (
        <li key={point.at} className="hop" style={cssVars({ "--d": ((point.ms ?? 0) / longest) * 100 })}>
          <div className="lab">
            <b>{point.label}</b> <i>{point.where}</i>
          </div>
          <span className="stem" aria-hidden="true" />
          <div className="val">{point.ms === null ? "none" : seconds(point.ms)}</div>
        </li>
      ))}
    </ol>
  );
}

function Signing({ latency }: { latency: MpcLatency }) {
  return (
    <section className="sec" aria-labelledby="signing">
      <h2 id="signing">Signatures, measured apart.</h2>
      <p className="prose">
        {latency.signed} of {latency.runs} signed on NEAR {latency.network}, median {seconds(latency.p50Ms ?? 0)}, p95 {seconds(latency.p95Ms ?? 0)}, slowest {seconds(latency.slowestMs ?? 0)}. {latency.note}
      </p>
      <details>
        <summary>Every sample</summary>
        <table className="nums">
          <thead>
            <tr>
              <th scope="col">Sample</th>
              <th scope="col">Outcome</th>
              <th scope="col">Time</th>
              <th scope="col">NEAR</th>
            </tr>
          </thead>
          <tbody>
            {latency.samples.map((sample) => (
              <tr key={sample.run}>
                <td>{sample.run + 1}</td>
                <td>{sample.outcome}</td>
                <td>
                  <Num>{seconds(sample.elapsedMs)}</Num>
                </td>
                <td>{sample.nearTx ? <a href={`https://testnet.nearblocks.io/txns/${sample.nearTx}`}>NearBlocks</a> : "none"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}

function ForkRehearsal({ rehearsal }: { rehearsal: Rehearsal }) {
  const { run, label } = rehearsal;
  const near = nearLink(run);
  return (
    <section className="sec" aria-labelledby="fork">
      <h2 id="fork">A rehearsal on a fork, not a run.</h2>
      <p className="prose">{label}</p>
      <p className="prose">
        It repaid {usdcAmount(run.amount)}, and health factor went from {run.healthBefore} to {run.healthAfter} in {run.latencyMs === null ? "an unrecorded time" : seconds(run.latencyMs)}. It is not counted in the runs above.{" "}
        {near && (
          <>
            The NEAR side is public on <a href={near.href}>NearBlocks</a>.
          </>
        )}
      </p>
    </section>
  );
}

function BacktestSection({ backtest }: { backtest: Backtest }) {
  const { cell } = backtest.headline;
  const honest = honestFigures(backtest);
  const windows = [...new Set(backtest.population.map((row) => row.window))];
  const chains = [...new Set(backtest.population.map((row) => row.chain))];
  const share = (count: number, total: number) => percent(count / total);
  const reasons = (Object.keys(MISS_NAMES) as MissReason[]).map((reason) => ({ reason, count: cell.reasons[reason] })).sort((a, b) => b.count - a.count);
  const topExclusions = backtest.exclusions.slice(0, 3).map((row) => `${row.reason} (${integer(row.positions)})`);

  return (
    <section id="backtest" className="sec" aria-labelledby="backtest-title">
      <h2 id="backtest-title">Reserve size decides the backtest.</h2>
      <p className="prose">
        A replay of {integer(cell.positions)} Aave positions that were really liquidated, on {joined(chains.map((chain) => chain[0]?.toUpperCase() + chain.slice(1)))}, in the windows {joined(windows)}. <b>A simulation, not rescues that happened.</b> It assumes the keeper, the RPCs, NEAR and the MPC network all worked through the worst minutes, with a fixed delay of {cell.delaySec} seconds. None of that has been run end to end. Trigger {cell.trigger.toFixed(2)}, target {cell.target.toFixed(2)}.
      </p>
      <div className="scroll">
        <table className="nums">
          <thead>
            <tr>
              <th scope="col">Reserve, share of debt</th>
              {backtest.fair.map((row) => (
                <th key={row.reserveShare} scope="col">
                  {plainShare(row.reserveShare)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(
              [
                ["Levee saved", "levee"],
                ["Same USDC held as collateral, no keeper", "holdAsCollateral"],
                ["Same USDC repaid at the start, no keeper", "repayAtArming"],
              ] as const
            ).map(([label, key]) => (
              <tr key={key}>
                <td>{label}</td>
                {backtest.fair.map((row) => (
                  <td key={row.reserveShare} className={key === "levee" ? "strong" : undefined}>
                    <Num>{share(row[key], row.positions)}</Num>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="note">Saved means the position outlived the window. No single column is the result: most positions needed a reserve near 30% of debt, so one reserve size flatters or hurts by where it falls.</p>

      <h3>Where Levee is no better</h3>
      <ul className="prose-list">
        {honest.collateralAtLeastAsGood.map((row) => (
          <li key={row.reserveShare}>
            At a {plainShare(row.reserveShare)} reserve, plain USDC collateral survived more often than Levee: {share(row.holdAsCollateral, row.positions)} against {share(row.levee, row.positions)}.
          </li>
        ))}
        {honest.repayAtArmingNeverWorse && <li>Repaying the same USDC at the start, with no keeper at all, did at least as well as Levee at every reserve size.</li>}
        <li>
          {integer(honest.armedBelow)} of the {integer(cell.positions)} positions were already below the trigger when the replay began, so their repay fired at once. That is an upfront repay and not a rescue. Among the {integer(honest.armedAbove)} where a race really ran, {integer(honest.savedArmedAbove)} ({share(honest.savedArmedAbove, honest.armedAbove)}) were saved at a {plainShare(cell.reserveShare)} reserve.
        </li>
        <li>
          At that reserve, {integer(honest.bothSurvive)} positions survived either way, so Levee added no survival benefit. {integer(honest.collateralOnly)} survived as plain collateral and not with Levee, because its repay came too late.
        </li>
      </ul>

      <h3>The misses, at a {plainShare(cell.reserveShare)} reserve</h3>
      <p className="prose">
        {integer(cell.notSaved)} of {integer(cell.positions)} were not saved. {integer(cell.failedLaterInWindow)} of those outlived the first real liquidation and fell below 1.00 later.
      </p>
      <div className="scroll">
        <table className="prose-table stack" role="table" aria-label="Why positions were not saved">
          <thead role="rowgroup">
            <tr role="row">
              {["Why", "Positions", "Share", "What happened"].map((label) => (
                <th key={label} scope="col" role="columnheader">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody role="rowgroup">
            {reasons.map(({ reason, count }) => (
              <tr key={reason} role="row">
                <td role="cell" data-label="Why">
                  {MISS_NAMES[reason]}
                </td>
                <td role="cell" data-label="Positions" className="num">
                  <Num>{integer(count)}</Num>
                </td>
                <td role="cell" data-label="Share" className="num">
                  <Num>{share(count, cell.positions)}</Num>
                </td>
                <td role="cell" data-label="What happened" data-plain="true">
                  {MISS_MEANINGS[reason]}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>What it leaves out</h3>
      <ul className="prose-list">
        <li>Not modelled: MPC down, keeper down, RPCs disagreeing under load, congestion beyond the delay, gas above the fee ceiling.</li>
        <li>Only liquidated positions are in the sample. Borrowers who crossed the trigger and recovered are not, so false alarms are not measured, and bonus avoided is not a return on reserves in general.</li>
        <li>A saved position still holds the fallen collateral, and its owner may have done better or worse than the liquidated outcome.</li>
        <li>
          {integer(backtest.excludedPositions)} more positions are out of scope, because their debt was not native USDC. The largest groups: {joined(topExclusions)}.
        </li>
        <li>
          The windows differ. At a {plainShare(cell.reserveShare)} reserve: {joined(backtest.byWindow.map((row) => `${row.group}, ${share(row.saved, row.positions)} saved`))}.
        </li>
      </ul>
      <p className="note">
        Debt liquidated in the sample: {dollars(backtest.population.reduce((total, row) => total + row.liquidatedDebtUsd, 0))}. Reserve used on saved positions at this cell: {usd(cell.reserveUsedOnSavedUsd)} of {usd(cell.reserveHeldUsd)} held.
      </p>
    </section>
  );
}

export default function ProofPage() {
  const runs = readRuns();
  const counts = tally(runs);
  const { hops, overall } = latencyTable(runs);
  const latency = readMpcLatency();
  const rehearsal = readRehearsal();
  const backtest = readBacktest();

  return (
    <>
      <SiteHeader here="proof" />
      <main id="main">
        <div className="lead-block">
          <h1 className="lead-title">{headline(counts)}</h1>
          <p>{scopeLine(counts)}</p>
        </div>
        <HopStrip runs={runs} />
        {runs.length > 0 && (
          <Fragment>
            <section className="sec" aria-labelledby="timings">
              <h2 id="timings">Each hop, computed from the records.</h2>
              <p className="prose">p50 and p95 are nearest rank, over {overall.samples} runs that got to the end. With so few runs the p95 is the slowest run. The aborted run stopped before any hop finished, so it is in the list below and not in these times.</p>
              <MeasuredTable hops={hops} overall={overall} />
            </section>
            <section className="sec" aria-labelledby="runs">
              <h2 id="runs">Every run.</h2>
              <p className="prose">Each row comes from a file in evidence/runs, read when this site was built. Failed and aborted runs stay on the list.</p>
              <RunsTable runs={runs} />
            </section>
          </Fragment>
        )}
        {latency && <Signing latency={latency} />}
        {rehearsal && <ForkRehearsal rehearsal={rehearsal} />}
        {backtest && <BacktestSection backtest={backtest} />}
      </main>
    </>
  );
}
