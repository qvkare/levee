import Link from "next/link";
import { seconds } from "@/lib/format.ts";
import { CONTRACT_ID, CONTRACT_URL, GITHUB_URL } from "@/lib/links.ts";
import { PROOF, type ProofRun, type Signing } from "@/lib/proof.ts";
import { Badge } from "./badge.tsx";
import { Marey } from "./marey.tsx";

const STATUS: Record<ProofRun["outcome"], string> = { success: "Landed", failed: "Did not land", aborted: "Stopped itself", unreadable: "Unreadable" };

const shortChain = (run: ProofRun) => run.chain.split(" ")[0] ?? run.chain;

function Departure({ run }: { run: ProofRun }) {
  const landed = run.outcome === "success";
  const label = run.time ?? run.id;
  return (
    <li className={`dep dep-${run.outcome}${run.replayed ? " dep-me" : ""}`}>
      <span className="dep-t mono">{label}</span>
      <span className="dep-d mono">{run.totalMs === null ? "none" : seconds(run.totalMs)}</span>
      <span className="dep-o">
        <i aria-hidden="true" />
        <span className="dep-word">{STATUS[run.outcome]}</span>
        {run.replayed && <span className="dep-note">· replayed</span>}
      </span>
      <span className="dep-l">
        {run.near && (
          <a href={run.near.href} rel="noreferrer" aria-label={`NEAR transaction for the ${label} run`}>
            NEAR
          </a>
        )}
        {run.evm && (
          <a href={run.evm.href} rel="noreferrer" aria-label={`${shortChain(run)} transaction for the ${label} run`}>
            {shortChain(run)}
          </a>
        )}
      </span>
      {!landed && (run.why ?? run.reason) && <span className="dep-why">{run.why ?? run.reason}</span>}
    </li>
  );
}

/** Every run, newest first, failures included. */
export function Departures({ runs }: { runs: ProofRun[] }) {
  return (
    <div className="depart">
      <h3>
        Departures <span>UTC, {PROOF.days}</span>
      </h3>
      <ol className="deps" aria-label="Every run, newest first">
        {runs.map((run) => (
          <Departure key={run.id} run={run} />
        ))}
      </ol>
    </div>
  );
}

/** The signature-only test: one dot per sample, on a time axis. */
export function SigningDots({ signing }: { signing: Signing }) {
  const times = signing.samples.filter((sample) => sample.outcome === "signed").map((sample) => sample.elapsedMs / 1000);
  if (times.length === 0 || signing.p50Ms === null) return null;
  const low = Math.floor((Math.min(...times) - 0.05) * 5) / 5;
  const high = Math.ceil((Math.max(...times) + 0.05) * 5) / 5;
  const at = (value: number) => `${((value - low) / (high - low)) * 100}%`;
  const ticks: number[] = [];
  for (let tick = low; tick <= high + 1e-9; tick += 0.4) ticks.push(Math.round(tick * 10) / 10);
  let previous = -1;
  let level = 0;
  const dots = [...times]
    .sort((a, b) => a - b)
    .map((value) => {
      level = previous >= 0 && value - previous < 0.05 ? level + 1 : 0;
      if (level === 0) previous = value;
      return { value, level };
    });
  const median = signing.p50Ms / 1000;
  return (
    <div className="dots" role="img" aria-label={`${times.length} signature times between ${Math.min(...times).toFixed(1)} and ${Math.max(...times).toFixed(1)} seconds, median ${median.toFixed(1)} seconds`}>
      {dots.map((dot, index) => (
        <i key={index} style={{ left: at(dot.value), bottom: `${4 + dot.level * 14}px` }} />
      ))}
      {ticks.map((tick) => (
        <span key={tick} className="dots-tick mono" style={{ left: at(tick) }}>
          {tick.toFixed(1)} s
        </span>
      ))}
      <div className="dots-p50" style={{ left: at(median) }}>
        <span>median {median.toFixed(1)} s</span>
      </div>
    </div>
  );
}

export function SigningSummary({ signing }: { signing: Signing }) {
  return (
    <p>
      {signing.signed} of {signing.runs} signed on NEAR {signing.network}, median {seconds(signing.p50Ms ?? 0)}, slowest {seconds(signing.slowestMs ?? 0)}. {signing.note}
    </p>
  );
}

/** The contract on NearBlocks, the source when it is public, and one more place to go. */
export function OutLinks({ next }: { next: { href: string; title: string; body: string } }) {
  return (
    <div className="signs">
      <a className="sign-card sign-card-N" href={CONTRACT_URL} rel="noreferrer">
        <span className="badge badge-on" aria-hidden="true">
          N
        </span>
        <span>
          <b>{CONTRACT_ID}</b>
          <small>The contract on NearBlocks, with every rescue call</small>
        </span>
      </a>
      {GITHUB_URL ? (
        <a className="sign-card sign-card-plain" href={GITHUB_URL} rel="noreferrer">
          <Badge lane="I" />
          <span>
            <b>Source on GitHub</b>
            <small>Contract, keeper, site and evidence</small>
          </span>
        </a>
      ) : (
        <Link className="sign-card sign-card-plain" href={next.href} prefetch={false}>
          <Badge lane="K" />
          <span>
            <b>{next.title}</b>
            <small>{next.body}</small>
          </span>
        </Link>
      )}
    </div>
  );
}

/** The run count, outcomes, place, day and times, in two or three sentences. */
export function intro(): string {
  const { counts, overall, days } = PROOF;
  const parts = [`${counts.success} ${counts.success === 1 ? "repay" : "repays"} landed`];
  if (counts.aborted) parts.push(`${counts.aborted} ${counts.aborted === 1 ? "run" : "runs"} stopped ${counts.aborted === 1 ? "itself" : "themselves"}`);
  if (counts.failed) parts.push(`${counts.failed} did not land`);
  const head = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
  const where = `${counts.positions === 1 ? "One test position" : `${counts.positions} test positions`} on ${counts.chains.join(" and ")}, ${days}.`;
  const slow = overall.slowestMs === overall.p95Ms ? `slowest ${seconds(overall.slowestMs ?? 0)}` : `p95 ${seconds(overall.p95Ms ?? 0)}`;
  const mainnet = counts.testnetOnly ? " Nothing here has run on a mainnet." : "";
  return `${head}. ${where} Median ${seconds(overall.p50Ms ?? 0)} from detection to inclusion, ${slow}.${mainnet}`;
}

/** The timetable: every landed run on one chart, every run on the board, and signing on its own. */
export function Timetable({ id = "proof", next, replayAbove = true }: { id?: string; next: { href: string; title: string; body: string }; replayAbove?: boolean }) {
  const { runs, counts, signing } = PROOF;
  if (counts.total === 0) return null;
  return (
    <section className="s" id={id} aria-labelledby={`${id}-h`}>
      <div className="sh">
        <h2 className="big" id={`${id}-h`}>
          Timetable of {counts.total} testnet {counts.total === 1 ? "run" : "runs"}
        </h2>
        <p>{intro()}</p>
      </div>
      <div className="proof-grid">
        <div className="card">
          <h3>Every landed run, stop by stop</h3>
          <p className="cap">Each line is one run. Steeper means faster. The blue line is the run {replayAbove ? "replayed above" : "the home page replays"}.</p>
          <Marey runs={runs} />
        </div>
        <Departures runs={runs} />
      </div>
      {signing && (
        <div className="mpc">
          <div>
            <h3>Signing on its own</h3>
            <SigningSummary signing={signing} />
          </div>
          <SigningDots signing={signing} />
        </div>
      )}
      <OutLinks next={next} />
    </section>
  );
}
