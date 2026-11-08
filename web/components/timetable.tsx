import Link from "next/link";
import { countWord, seconds } from "@/lib/format.ts";
import { CONTRACT_ID, CONTRACT_URL, GITHUB_URL, UNWIND_URL } from "@/lib/links.ts";
import { PROOF, type Mode, type ModeFigures, type ProofRun, type Signing } from "@/lib/proof.ts";
import { Badge } from "./badge.tsx";
import { Marey } from "./marey.tsx";

const STATUS: Record<ProofRun["outcome"], string> = { success: "Landed", failed: "Did not land", aborted: "Stopped itself", unreadable: "Unreadable" };

export const MODE_NAMES: Record<Mode, string> = { collateral: "Repay from collateral", reserve: "Repay from a reserve" };

const shortChain = (run: ProofRun) => run.chain.split(" ")[0] ?? run.chain;

function Departure({ run }: { run: ProofRun }) {
  const landed = run.outcome === "success";
  const label = run.time ?? run.id;
  const note = !landed ? (run.why ?? run.reason) : run.keyless ? "Landed after both contract accounts lost their last key." : null;
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
      {note && <span className="dep-why">{note}</span>}
    </li>
  );
}

/** Every run, newest first, failures included, under its mode. */
export function Departures({ runs }: { runs: ProofRun[] }) {
  const groups = (["collateral", "reserve"] as Mode[]).map((mode) => ({ mode, figures: PROOF.modes[mode], runs: runs.filter((run) => run.mode === mode) })).filter((group) => group.runs.length > 0);
  return (
    <div className="depart">
      <h3>
        Departures <span>UTC, {PROOF.days}</span>
      </h3>
      {groups.map((group) => (
        <section key={group.mode} className="dep-group" aria-label={MODE_NAMES[group.mode]}>
          <h4>
            {MODE_NAMES[group.mode]}
            <span>
              {[group.figures.versions.join(" and "), group.figures.days].filter(Boolean).join(" · ")}
            </span>
          </h4>
          <ol className="deps" aria-label={`${MODE_NAMES[group.mode]}, newest first`}>
            {group.runs.map((run) => (
              <Departure key={run.id} run={run} />
            ))}
          </ol>
        </section>
      ))}
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

/** The contract on NearBlocks, the helper on Basescan, the source when it is public, and one more place to go. */
export function OutLinks({ next }: { next: { href: string; title: string; body: string } }) {
  return (
    <div className="signs">
      <a className="sign-card sign-card-N" href={CONTRACT_URL} rel="noreferrer">
        <span className="badge badge-on" aria-hidden="true">
          N
        </span>
        <span>
          <b>{CONTRACT_ID}</b>
          <small>The v0.2 contract on NearBlocks, with every rescue call</small>
        </span>
      </a>
      <a className="sign-card sign-card-U" href={UNWIND_URL} rel="noreferrer">
        <span className="badge badge-on" aria-hidden="true">
          U
        </span>
        <span>
          <b>LeveeUnwind</b>
          <small>The helper on Basescan Sepolia, with every unwind</small>
        </span>
      </a>
      {GITHUB_URL ? (
        <a className="sign-card sign-card-plain" href={GITHUB_URL} rel="noreferrer">
          <Badge lane="I" />
          <span>
            <b>Source on GitHub</b>
            <small>Contracts, keeper, site and evidence</small>
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

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** One mode's runs in a sentence: what landed, what stopped, when, and how long. */
export function modeSentence(figures: ModeFigures): string {
  const { counts, timing, days } = figures;
  const parts = [`${counts.success} landed`];
  if (counts.aborted) parts.push(`${counts.aborted} stopped ${counts.aborted === 1 ? "itself" : "themselves"}`);
  if (counts.failed) parts.push(`${counts.failed} did not land`);
  const head = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
  const median = timing.overall.p50Ms === null ? "" : `, median ${seconds(timing.overall.p50Ms)} from detection to inclusion`;
  return `${MODE_NAMES[figures.mode]}: ${head}, ${days}${median}.`;
}

/** The run count, outcomes, place, days and times, mode by mode. */
export function intro(): string {
  const { counts, modes } = PROOF;
  const sentences = (["collateral", "reserve"] as Mode[]).filter((mode) => modes[mode].counts.total > 0).map((mode) => modeSentence(modes[mode]));
  const where = `${counts.positions === 1 ? "One test position" : `${countWord(counts.positions)} test positions`} on ${counts.chains.join(" and ")}.`;
  const mainnet = counts.testnetOnly ? " Nothing here has run on a mainnet." : "";
  return `${sentences.join(" ")} ${where}${mainnet}`;
}

/** The timetable: every landed run on one chart, every run on the board, and signing on its own. */
export function Timetable({ id = "proof", next, replayAbove = true }: { id?: string; next: { href: string; title: string; body: string }; replayAbove?: boolean }) {
  const { runs, counts, signing } = PROOF;
  if (counts.total === 0) return null;
  return (
    <section className="s" id={id} aria-labelledby={`${id}-h`}>
      <div className="sh">
        <h2 className="big" id={`${id}-h`}>
          Timetable of {plural(counts.total, "testnet run", "testnet runs")}
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
