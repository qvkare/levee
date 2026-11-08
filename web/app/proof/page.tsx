import type { Metadata } from "next";
import { BacktestBody, BacktestMisses, BacktestSizes, ReserveBacktest, backtestIntro } from "@/components/backtest.tsx";
import { MeasuredTable } from "@/components/measured-table.tsx";
import { TextTable, type Column } from "@/components/text-table.tsx";
import { MODE_NAMES, Timetable, intro } from "@/components/timetable.tsx";
import { ACCOUNTS, OWN, THIRD_PARTY, type ContractRow, type KeyDeletion } from "@/lib/contracts.ts";
import { countWord, integer, joined, seconds } from "@/lib/format.ts";
import { day } from "@/lib/proof-model.ts";
import { PROOF, type Keyless, type ProofRun, type Signing } from "@/lib/proof.ts";

/** Built once, from the run records, the claims ledger and the backtests inlined at build time. */
export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Proof",
  description: "Every recorded Levee run on testnet, the aborted ones included, with explorer links and every hop, the contracts and their deleted keys, the signing test, and the collateral backtest with its caveats.",
};

const OUTCOME_NAMES: Record<ProofRun["outcome"], string> = { success: "Landed", failed: "Did not land", aborted: "Stopped itself", unreadable: "Unreadable" };

const at = (ms: number | null) => (ms === null ? "none" : `${(ms / 1000).toFixed(2)} s`);

const SEEDED = "The team added the liquidity in the testnet pool at Aave’s oracle price, so testnet sale prices are no measure of slippage. Slippage is measured in the backtest, from historical Uniswap quotes.";

function RunsTable({ runs }: { runs: ProofRun[] }) {
  return (
    <div className="scroll" tabIndex={0} role="region" aria-label="Every recorded run">
      <table className="wide-table runs-table">
        <thead>
          <tr>
            <th scope="col">Run, UTC</th>
            <th scope="col">Mode</th>
            <th scope="col">Outcome</th>
            <th scope="col">Repaid</th>
            <th scope="col">Sold, and the keeper’s cap</th>
            <th scope="col">Price against the oracle, seeded pool</th>
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
              <td>
                {run.mode === "collateral" ? "Collateral" : "Reserve"}
                {run.version && <small>{run.version}</small>}
              </td>
              <td className="wrap">
                {OUTCOME_NAMES[run.outcome]}
                {run.replayed && <small>Replayed on the home page</small>}
                {run.keyless && <small>Landed after both contract accounts lost their last key</small>}
                {run.why && <small>{run.why}</small>}
                {run.reason && <small className="mono">{run.reason}</small>}
              </td>
              <td>
                {run.outcome === "success" ? (run.amount ?? "none") : "none"}
                {run.outcome !== "success" && run.amount && <small>sized at {run.amount}</small>}
              </td>
              <td>
                {run.sale?.sold ?? "none"}
                {run.sale?.maxSold && <small>cap {run.sale.maxSold}</small>}
              </td>
              <td>{run.sale?.discountBps == null ? "none" : `${run.sale.discountBps} bps under`}</td>
              <td>
                {run.healthBefore ? (run.healthAfter ? `${Number(run.healthBefore).toFixed(4)} to ${Number(run.healthAfter).toFixed(4)}` : Number(run.healthBefore).toFixed(4)) : "not read"}
                {run.healthBefore && !run.healthAfter && <small>{run.outcome === "success" ? "after not read" : "nothing landed"}</small>}
              </td>
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

const address = (row: ContractRow) => (
  <a className="mono addr" href={row.href} rel="noreferrer">
    {row.address}
  </a>
);

const CONTRACT_COLUMNS: Column<ContractRow>[] = [
  { label: "Contract", plain: true, cell: (row) => row.name },
  { label: "Network", nowrap: true, cell: (row) => row.network },
  { label: "Address", nowrap: true, cell: address },
  {
    label: "Source",
    plain: true,
    cell: (row) =>
      row.sourceHref ? (
        <a href={row.sourceHref} rel="noreferrer">
          {row.source}
        </a>
      ) : (
        (row.source ?? "")
      ),
  },
];

const ACCOUNT_COLUMNS: Column<ContractRow>[] = CONTRACT_COLUMNS.slice(0, 3).map((column, index) => (index === 0 ? { ...column, label: "Account" } : column));

const DELETION_COLUMNS: Column<KeyDeletion>[] = [
  { label: "Account", nowrap: true, cell: (row) => <span className="mono addr">{row.account}</span> },
  { label: "Version", nowrap: true, cell: (row) => row.version },
  { label: "Last full-access key, deleted", plain: true, cell: (row) => <span className="mono addr">{row.key}</span> },
  {
    label: "NEAR transaction",
    cell: (row) => (
      <a className="mono addr" href={row.href} rel="noreferrer">
        {row.tx}
      </a>
    ),
  },
  { label: "Block", nowrap: true, cell: (row) => integer(row.block) },
];

function KeylessSection({ keyless }: { keyless: Keyless }) {
  const run = PROOF.runs.find((entry) => entry.id === keyless.run);
  return (
    <>
      <TextTable columns={DELETION_COLUMNS} rows={keyless.deletions} rowKey={(row) => row.account} label="Key deletions" />
      <p className="prose">
        Neither account has an access key left, so nobody can change either contract’s code or sign as the contract account. {run ? `The rescue at ${run.time} UTC on ${run.detectedAt === null ? "" : day(run.detectedAt)}` : "A rescue"} landed after both deletions, its NEAR call at block {integer(keyless.afterBlock)}
        {run?.near && run.evm ? (
          <>
            : <a href={run.near.href}>NEAR</a>, <a href={run.evm.href}>{run.chain}</a>.
          </>
        ) : (
          "."
        )}{" "}
        The claims ledger records it as <code>{keyless.claimId}</code>, and <code>make verify</code> reads both key lists from NEAR and fails if any key is there.
      </p>
    </>
  );
}

export default function ProofPage() {
  const { runs, modes, counts, signing, rehearsal, backtest, reserveBacktest, keyless } = PROOF;
  const collateralRuns = modes.collateral.counts.total;

  return (
    <main id="main">
      <div className="page-head">
        <h1>Every run, every figure</h1>
        <p className="lede">{counts.total === 0 ? "No live runs yet. Each run will appear here with its transactions, the failed ones included." : `${intro()} Failed and aborted runs stay on this page.`}</p>
      </div>

      <Timetable id="timetable" replayAbove={false} next={{ href: "/how", title: "How a rescue runs", body: "The line stop by stop, who can do what, and when it fails" }} />

      <section className="s s-tint" id="contracts" aria-labelledby="contracts-h">
        <div className="sh">
          <h2 className="big" id="contracts-h">
            Contracts and keys
          </h2>
          <p>Everything here is on testnet. Nothing is deployed on any mainnet. The last full-access key on each Levee contract account was deleted.</p>
        </div>
        {keyless && <KeylessSection keyless={keyless} />}
        <h3 className="sub">Levee’s own</h3>
        <TextTable columns={CONTRACT_COLUMNS} rows={OWN} rowKey={(row) => row.address} label="Levee's own contracts" />
        <h3 className="sub">Accounts Levee acts through</h3>
        <TextTable columns={ACCOUNT_COLUMNS} rows={ACCOUNTS} rowKey={(row) => row.address} label="Accounts Levee acts through" />
        <h3 className="sub">Third-party contracts it calls</h3>
        <TextTable columns={ACCOUNT_COLUMNS.map((column, index) => (index === 0 ? { ...column, label: "Contract" } : column))} rows={THIRD_PARTY} rowKey={(row) => row.address} label="Third-party contracts" />
      </section>

      {counts.total > 0 && (
        <section className="s" id="hops" aria-labelledby="hops-h">
          <div className="sh">
            <h2 className="big" id="hops-h">
              Each hop
            </h2>
            <p>Medians, and p95 by nearest rank, over the runs that landed in each mode. With this few runs the p95 is the slowest run. A run that stopped itself finished no hop, so it is in the list below and out of these times.</p>
          </div>
          <MeasuredTable modes={[modes.collateral, modes.reserve]} />
        </section>
      )}

      {counts.total > 0 && (
        <section className="s s-tint" id="runs" aria-labelledby="runs-h">
          <div className="sh">
            <h2 className="big" id="runs-h">
              Every run
            </h2>
            <p>
              Each row is a file in evidence/runs, read when this site was built. Times are from detection. Failed and aborted runs stay on the list.
              {collateralRuns > 0 && ` ${SEEDED}`}
            </p>
          </div>
          <RunsTable runs={runs} />
          {collateralRuns > 0 && <p className="note-line">The price includes the pool fee. Each unwind landed just above its target, because the keeper sizes for the fee and the whole bound.</p>}
        </section>
      )}

      {signing && (
        <section className="s" id="signing" aria-labelledby="signing-h">
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
        <section className="s s-tint" id="fork" aria-labelledby="fork-h">
          <div className="sh">
            <h2 className="big" id="fork-h">
              The fork rehearsal
            </h2>
            <p>{rehearsal.label}</p>
          </div>
          <p className="prose">
            A rehearsal of the reserve mode. It repaid {rehearsal.amount ?? "nothing"}, and health factor went from {rehearsal.healthBefore ?? "unread"} to {rehearsal.healthAfter ?? "unread"} in {rehearsal.latencyMs === null ? "an unrecorded time" : seconds(rehearsal.latencyMs)}. It is kept apart from the runs above, because no public explorer can show a fork.{" "}
            {rehearsal.near && (
              <>
                The NEAR side is public on <a href={rehearsal.near.href}>NearBlocks</a>.
              </>
            )}
          </p>
        </section>
      )}

      {backtest && (
        <section className="s" id="backtest" aria-labelledby="backtest-h">
          <div className="sh">
            <h2 className="big" id="backtest-h">
              Backtest: repay from collateral
            </h2>
            <p>{backtestIntro(backtest)}</p>
          </div>
          <BacktestBody backtest={backtest} />
          <h3 className="sub">Why liquidated positions were missed</h3>
          <BacktestMisses backtest={backtest} />
          <h3 className="sub">Net by size of position</h3>
          <BacktestSizes backtest={backtest} />
          <p className="note-line">Method, validation and every table: backtest/README.md and backtest/results/collateral.md, recomputed by make backtest.</p>

          {reserveBacktest && (
            <>
              <h3 className="sub">{MODE_NAMES.reserve}, the second mode</h3>
              <ReserveBacktest backtest={reserveBacktest} />
            </>
          )}
        </section>
      )}

      <section className="s s-tint" id="limits" aria-labelledby="limits-h">
        <div className="sh">
          <h2 className="big" id="limits-h">
            Limits of this proof
          </h2>
        </div>
        <ul className="prose-list">
          <li>
            Every live run is on {joined(counts.chains) || "a testnet"}, from {counts.positions === 1 ? "one position" : `${countWord(counts.positions).toLowerCase()} positions`}, on {PROOF.days}. Nothing has run on a mainnet or during a crash.
          </li>
          <li>
            {countWord(modes.collateral.timing.overall.samples)} landed collateral {modes.collateral.timing.overall.samples === 1 ? "run is" : "runs are"} too few for a p95 to mean much. With this many it is the slowest run.
          </li>
          {collateralRuns > 0 && <li>{SEEDED}</li>}
          <li>The replay on the home page draws the fall before detection. No record times it, and the page says so.</li>
          <li>The backtest is a simulation. It assumes the keeper, RPCs, NEAR and the MPC network all worked through the worst minutes, and that each sale filled at its quote, alone in its block.</li>
        </ul>
      </section>
    </main>
  );
}
