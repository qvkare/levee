import type { Metadata } from "next";
import { BacktestBody, BacktestTable, Remeasured, backtestIntro } from "@/components/backtest.tsx";
import { MeasuredTable } from "@/components/measured-table.tsx";
import { Timetable, intro } from "@/components/timetable.tsx";
import { countShare, countWord, dollars, integer, joined, seconds, usd } from "@/lib/format.ts";
import { PROOF, type BacktestFigures, type ProofRun, type Signing } from "@/lib/proof.ts";

/** Built once, from the run records and the backtest summary inlined at build time. */
export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Proof",
  description: "Every recorded Levee run, the aborted one included, with explorer links and every hop, the signing test, the fork rehearsal, and the backtest with its misses and limits.",
};

const OUTCOME_NAMES: Record<ProofRun["outcome"], string> = { success: "Landed", failed: "Did not land", aborted: "Stopped itself", unreadable: "Unreadable" };

const at = (ms: number | null) => (ms === null ? "none" : `${(ms / 1000).toFixed(2)} s`);

function RunsTable({ runs }: { runs: ProofRun[] }) {
  return (
    <div className="scroll" tabIndex={0} role="region" aria-label="Every recorded run">
      <table className="wide-table">
        <thead>
          <tr>
            <th scope="col">Run, UTC</th>
            <th scope="col">Outcome</th>
            <th scope="col">Repaid</th>
            <th scope="col">Health factor</th>
            <th scope="col">On NEAR</th>
            <th scope="col">Signed</th>
            <th scope="col">Sent</th>
            <th scope="col">Included</th>
            <th scope="col">Transactions</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id}>
              <th scope="row">
                {run.time ?? "unknown"}
                <small className="mono">{run.id}</small>
              </th>
              <td className="wrap">
                {OUTCOME_NAMES[run.outcome]}
                {run.replayed && <small>Replayed on the home page</small>}
                {run.why && <small>{run.why}</small>}
                {run.reason && <small className="mono">{run.reason}</small>}
              </td>
              <td>{run.amount ?? "none"}</td>
              <td>{run.healthBefore ? `${Number(run.healthBefore).toFixed(4)} to ${run.healthAfter ? Number(run.healthAfter).toFixed(2) : "not read"}` : "not read"}</td>
              <td>{at(run.marks.near)}</td>
              <td>{at(run.marks.signed)}</td>
              <td>{at(run.marks.sent)}</td>
              <td className={run.marks.included === null ? "soft" : "strong"}>{at(run.marks.included)}</td>
              <td>
                {run.near || run.evm ? (
                  <span className="tx-links">
                    {run.near && (
                      <a href={run.near.href} rel="noreferrer">
                        NearBlocks
                      </a>
                    )}
                    {run.evm && (
                      <a href={run.evm.href} rel="noreferrer">
                        {run.evm.label}
                        {run.evmBlock !== null && <span className="vh">, block {integer(run.evmBlock)}</span>}
                      </a>
                    )}
                  </span>
                ) : (
                  <span className="soft">none</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SigningSamples({ signing }: { signing: Signing }) {
  return (
    <div className="scroll" tabIndex={0} role="region" aria-label="Every signing sample">
      <table>
        <thead>
          <tr>
            <th scope="col">Sample</th>
            <th scope="col">Outcome</th>
            <th scope="col">Time</th>
            <th scope="col">NEAR</th>
          </tr>
        </thead>
        <tbody>
          {signing.samples.map((sample, index) => {
            const link = signing.links[index];
            return (
              <tr key={sample.run}>
                <th scope="row">{sample.run + 1}</th>
                <td>{sample.outcome}</td>
                <td>{seconds(sample.elapsedMs)}</td>
                <td>
                  {link ? (
                    <a href={link.href} rel="noreferrer">
                      NearBlocks
                    </a>
                  ) : (
                    "none"
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const pct = (fraction: number) => `${Math.round(fraction * 100)}%`;

function BacktestDetail({ backtest }: { backtest: BacktestFigures }) {
  const share = (count: number, total: number) => `${countShare(count, total)}%`;
  const cell = backtest.rows.find((row) => row.share === backtest.reserveShare);
  return (
    <>
      <h3 className="sub">All three rows</h3>
      <BacktestTable backtest={backtest} />
      <p className="note-line">Saved means the position outlived the window. No single column is the result: most positions needed a reserve near 30% of debt, so one reserve size flatters or hurts by where it falls.</p>

      <h3 className="sub">Where Levee did no better</h3>
      <ul className="prose-list">
        {backtest.rows
          .filter((row) => row.collateral >= row.levee)
          .map((row) => (
            <li key={row.share}>
              At a {pct(row.share)} reserve, plain USDC collateral survived more often than Levee: {share(row.collateral, row.positions)} against {share(row.levee, row.positions)}.
            </li>
          ))}
        {backtest.upfrontNeverWorse && <li>Repaying the same USDC at the start, with no keeper at all, did at least as well as Levee at every reserve size.</li>}
        <li>
          {integer(backtest.armedBelow)} of the {integer(backtest.positions)} positions were already below the trigger when the replay began, so their repay fired at once. That is an upfront repay. Among the {integer(backtest.armedAbove)} where a race really ran, {integer(backtest.savedArmedAbove)} ({share(backtest.savedArmedAbove, backtest.armedAbove)}) were saved at a {pct(backtest.reserveShare)} reserve.
        </li>
        {cell && (
          <li>
            At that reserve, {integer(backtest.bothSurvive)} positions survived either way, so Levee added no survival there. {integer(backtest.collateralOnly)} survived as plain collateral and were lost with Levee, because its repay came too late.
          </li>
        )}
      </ul>

      <h3 className="sub">The misses, at a {pct(backtest.reserveShare)} reserve</h3>
      <p className="prose">
        {integer(backtest.notSaved)} of {integer(backtest.positions)} were lost. {integer(backtest.failedLaterInWindow)} of those outlived the first real liquidation and fell below 1.00 later.
      </p>
      <div className="scroll" tabIndex={0} role="region" aria-label="Why positions were lost">
        <table>
          <thead>
            <tr>
              <th scope="col">Why</th>
              <th scope="col">Positions</th>
              <th scope="col">Share</th>
            </tr>
          </thead>
          <tbody>
            {backtest.misses.map((miss) => (
              <tr key={miss.reason}>
                <th scope="row">{miss.name}</th>
                <td>{integer(miss.count)}</td>
                <td>{share(miss.count, backtest.positions)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="sub">What it leaves out</h3>
      <ul className="prose-list">
        <li>Not modelled: MPC down, keeper down, RPCs disagreeing under load, congestion beyond the delay, gas above the fee ceiling.</li>
        <li>Only liquidated positions are in the sample. Borrowers who crossed the trigger and recovered are missing, so false alarms are not measured.</li>
        <li>A saved position still holds the fallen collateral, and its owner may have done better or worse than the liquidated outcome.</li>
        <li>
          {integer(backtest.excluded)} more positions are out of scope, because their debt was in something other than native USDC. The largest groups: {joined(backtest.topExclusions.map((row) => `${row.reason} (${integer(row.positions)})`))}.
        </li>
        <li>
          The windows differ. At a {pct(backtest.reserveShare)} reserve, {backtest.byWindow.map((row) => `${row.label}: ${share(row.saved, row.positions)} saved`).join(". ")}.
        </li>
      </ul>
      <p className="note-line">
        Debt liquidated in the sample: {dollars(backtest.liquidatedDebtUsd)}. Reserve used on saved positions at this reserve size: {usd(backtest.reserveUsedOnSavedUsd)} of {usd(backtest.reserveHeldUsd)} held.
      </p>
    </>
  );
}

export default function ProofPage() {
  const { runs, hops, overall, counts, signing, rehearsal, backtest } = PROOF;

  return (
    <main id="main">
      <div className="page-head">
        <h1>Every run, every figure</h1>
        <p className="lede">{counts.total === 0 ? "No live runs yet. Each run will appear here with its transactions, the failed ones included." : `${intro()} Levee is unaudited. Failed and aborted runs stay on this page.`}</p>
      </div>

      <Timetable id="timetable" replayAbove={false} next={{ href: "/how", title: "How a rescue runs", body: "The line stop by stop, who can do what, and when it fails" }} />

      {counts.total > 0 && (
        <section className="s s-tint" id="hops" aria-labelledby="hops-h">
          <div className="sh">
            <h2 className="big" id="hops-h">
              Each hop
            </h2>
            <p>p50 and p95 are nearest rank, over the {overall.samples} runs that landed. With this few runs the p95 is the slowest run. The run that stopped itself finished no hop, so it is in the list below and out of these times.</p>
          </div>
          <MeasuredTable hops={hops} overall={overall} />
        </section>
      )}

      {counts.total > 0 && (
        <section className="s" id="runs" aria-labelledby="runs-h">
          <div className="sh">
            <h2 className="big" id="runs-h">
              Every run
            </h2>
            <p>Each row is a file in evidence/runs, read when this site was built. Times are from detection. Failed and aborted runs stay on the list.</p>
          </div>
          <RunsTable runs={runs} />
        </section>
      )}

      {signing && (
        <section className="s s-tint" id="signing" aria-labelledby="signing-h">
          <div className="sh">
            <h2 className="big" id="signing-h">
              Every signing sample
            </h2>
            <p>
              {signing.signed} of {signing.runs} signed on NEAR {signing.network}, median {seconds(signing.p50Ms ?? 0)}, p95 {seconds(signing.p95Ms ?? 0)}, slowest {seconds(signing.slowestMs ?? 0)}. {signing.note}
            </p>
          </div>
          <SigningSamples signing={signing} />
        </section>
      )}

      {rehearsal && (
        <section className="s" id="fork" aria-labelledby="fork-h">
          <div className="sh">
            <h2 className="big" id="fork-h">
              The fork rehearsal
            </h2>
            <p>{rehearsal.label}</p>
          </div>
          <p className="prose">
            It repaid {rehearsal.amount ?? "nothing"}, and health factor went from {rehearsal.healthBefore ?? "unread"} to {rehearsal.healthAfter ?? "unread"} in {rehearsal.latencyMs === null ? "an unrecorded time" : seconds(rehearsal.latencyMs)}. It is kept apart from the runs above, because no public explorer can show a fork.{" "}
            {rehearsal.near && (
              <>
                The NEAR side is public on <a href={rehearsal.near.href}>NearBlocks</a>.
              </>
            )}
          </p>
        </section>
      )}

      {backtest && (
        <section className="s s-tint" id="backtest" aria-labelledby="backtest-h">
          <Remeasured />
          <div className="sh">
            <h2 className="big" id="backtest-h">
              Backtest on {integer(backtest.positions)} liquidated positions
            </h2>
            <p>{backtestIntro(backtest)}</p>
          </div>
          <BacktestBody backtest={backtest} />
          <BacktestDetail backtest={backtest} />
        </section>
      )}

      <section className="s" id="limits" aria-labelledby="limits-h">
        <div className="sh">
          <h2 className="big" id="limits-h">
            Limits of this proof
          </h2>
        </div>
        <ul className="prose-list">
          <li>Every live run is on {joined(counts.chains) || "a testnet"}, from {counts.positions === 1 ? "one position" : `${counts.positions} positions`}, on {PROOF.days}. Nothing has run on a mainnet or during a crash.</li>
          <li>
            {countWord(overall.samples)} landed {overall.samples === 1 ? "run is" : "runs are"} too few for a p95 to mean much. With this many it is the slowest run.
          </li>
          <li>The replay on the home page draws the fall before detection. No record times it, and the page says so.</li>
          <li>The backtest is a simulation and is being re-measured. It assumes the keeper, RPCs, NEAR and MPC all worked through the worst minutes.</li>
          <li>Levee is unaudited. Don’t use it with funds you can’t lose.</li>
        </ul>
      </section>
    </main>
  );
}
