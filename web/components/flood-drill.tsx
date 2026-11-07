"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { buildDrill, hopsFor, keyFrames, type Branch, type DrillFrame, type DrillRun, type DrillTerms } from "@/lib/drill.ts";
import { integer, percent, stageValue, usd } from "@/lib/format.ts";
import { OVERTOP_Y, chartY } from "@/lib/gauge.ts";
import { approxFall } from "@/lib/math.ts";
import { RiverSection } from "./river-section.tsx";
import { StackTable, type Column } from "./stack-table.tsx";
import { StateTag } from "./state-tag.tsx";

const REFRESH_TIMEOUT_MS = 2500;
/** Share of the section in view before the drill starts. */
const IN_VIEW = 0.6;

const BRANCHES: Array<{ id: Branch; label: string }> = [
  { id: "with", label: "With Levee" },
  { id: "without", label: "Without Levee" },
];

function subscribeToMotion(onChange: () => void) {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeToMotion, () => window.matchMedia("(prefers-reduced-motion: reduce)").matches, () => false);
}

/** True once the element has been in view. Below the fold on a phone, load comes long before that. */
function useSeen<T extends Element>() {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setSeen(true);
          observer.disconnect();
        }
      },
      { threshold: IN_VIEW },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, seen };
}

function modeLine(frame: DrillFrame, terms: DrillTerms): { state: "Live" | "Simulation" | null; text: string } {
  if (frame.round > 0) return { state: "Simulation", text: `Simulated round ${frame.round}, this position's terms` };
  if (terms.source === "example") return { state: "Simulation", text: "Example position, not a read" };
  const block = integer(terms.blockNumber ?? 0);
  // A chain read, but an old one, so neither tag is true.
  if (terms.source === "built") return { state: null, text: `Read at block ${block}, when this page was built` };
  return { state: "Live", text: `Read at block ${block}` };
}

const PHASE_NAMES: Partial<Record<DrillFrame["phase"], string>> = {
  reading: "First reading",
  trigger: "Trigger crossed",
  repaid: "Repay landed",
  flood: "Over flood stage",
  liquidated: "Liquidated",
};

interface StateRow {
  id: string;
  branch: string;
  frame: DrillFrame;
}

const STATE_COLUMNS: Column<StateRow>[] = [
  { label: "Path", cell: (row) => row.branch },
  { label: "State", cell: (row) => <span className="medium">{PHASE_NAMES[row.frame.phase]}</span>, emphasis: (row) => row.frame.over },
  { label: "Fall", numeric: true, cell: (row) => percent(row.frame.fall) },
  { label: "Collateral", numeric: true, cell: (row) => usd(row.frame.collateralUsd) },
  { label: "Debt", numeric: true, cell: (row) => usd(row.frame.debtUsd) },
  { label: "Health factor", numeric: true, cell: (row) => stageValue(row.frame.health) },
  { label: "What happens", wide: true, cell: (row) => row.frame.caption },
];

function StatesTable({ drill }: { drill: Record<Branch, DrillRun> }) {
  const rows = BRANCHES.flatMap(({ id, label }) => keyFrames(drill[id], id).map((frame) => ({ id: `${id}-${frame.phase}`, branch: label, frame })));
  return (
    <div className="drill-states">
      <StackTable caption="The drill's states. All but the first reading are simulated." columns={STATE_COLUMNS} rows={rows} rowKey={(row) => row.id} />
    </div>
  );
}

/** The home page's one orchestrated moment (web/DESIGN.md, Motion). */
export function FloodDrill({ initial }: { initial: DrillTerms }) {
  const [terms, setTerms] = useState(initial);
  const [ready, setReady] = useState(false);
  const [branch, setBranch] = useState<Branch>("with");
  const [replays, setReplays] = useState(0);
  const [index, setIndex] = useState(0);
  const reduced = useReducedMotion();
  const view = useSeen<HTMLDivElement>();

  const drill = useMemo(() => buildDrill(terms), [terms]);
  const run = drill[branch];

  // Take a fresh reading once. If it is slow or fails, the reading from the build stands.
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
    fetch("/api/drill", { signal: controller.signal })
      .then((response) => (response.ok ? (response.json() as Promise<DrillTerms>) : null))
      .then((fresh) => {
        if (fresh && fresh.source === "live") setTerms(fresh);
      })
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timer);
        setReady(true);
      });
    return () => controller.abort();
  }, []);

  // Play the chosen branch from the top, then stay on its final state.
  useEffect(() => {
    if (!ready || !view.seen || reduced) return;
    setIndex(0);
    let timer: ReturnType<typeof setTimeout>;
    const advance = (at: number) => {
      const frame = run.frames[at] as DrillFrame;
      if (at >= run.frames.length - 1) return;
      timer = setTimeout(() => {
        setIndex(at + 1);
        advance(at + 1);
      }, frame.holdMs);
    };
    advance(0);
    return () => clearTimeout(timer);
  }, [ready, view.seen, reduced, run, replays]);

  const frame = run.frames[Math.min(index, run.frames.length - 1)] as DrillFrame;
  const mode = modeLine(frame, terms);
  const hops = hopsFor(branch, run);
  const flooded = frame.phase === "flood" || frame.phase === "liquidating" || frame.over;
  const waterY = flooded && frame.phase !== "liquidated" ? OVERTOP_Y : chartY(approxFall(frame.health));
  const state = flooded && frame.phase !== "liquidated" ? "over" : "reading";
  const lines = [
    { id: "trigger", y: chartY(approxFall(terms.trigger)), label: `Trigger ${terms.trigger.toFixed(2)}` },
    { id: "target", y: chartY(approxFall(terms.target)), label: `Target ${terms.target.toFixed(2)}` },
  ];

  return (
    <figure className="drill" aria-label="Flood drill">
      <div className="drill-controls drill-play">
        <div className="segments" role="group" aria-label="Ending">
          {BRANCHES.map(({ id, label }) => (
            <button key={id} type="button" aria-pressed={branch === id} onClick={() => setBranch(id)}>
              {label}
            </button>
          ))}
        </div>
        <button className="button" data-kind="secondary" type="button" onClick={() => setReplays((count) => count + 1)}>
          Replay
        </button>
      </div>

      <div ref={view.ref}>
        <RiverSection state={state} waterY={waterY} lines={lines} fit="column" summary={`River section, ${mode.text}. Health factor ${stageValue(frame.health)}.`}>
          <div className="chart-reading" style={{ transform: `translateY(${waterY}%)` }} aria-hidden="true">
            <p className="water-label">Stage {stageValue(frame.health)}</p>
          </div>
        </RiverSection>
      </div>

      <p className="drill-mode">
        {mode.state && <StateTag state={mode.state} />}
        <span>{mode.text}</span>
      </p>

      <dl className="drill-figures">
        <div>
          <dt>Health factor</dt>
          <dd className={frame.over ? "flood-text" : undefined}>{stageValue(frame.health)}</dd>
        </div>
        <div>
          <dt>Collateral</dt>
          <dd>{usd(frame.collateralUsd)}</dd>
        </div>
        <div>
          <dt>Debt</dt>
          <dd>{usd(frame.debtUsd)}</dd>
        </div>
      </dl>

      <div className="drill-play">
        <p className={frame.over ? "drill-caption flood-text" : "drill-caption"} aria-live="polite">
          {frame.caption}
        </p>
        <ol className="hops" data-branch={branch}>
          {hops.map((hop, position) => (
            <li key={hop.name} data-on={frame.hops > position}>
              <span className="hop-mark" aria-hidden="true" />
              <span className="hop-name">{hop.name}</span>
              <span className="hop-detail">{hop.detail}</span>
            </li>
          ))}
        </ol>
      </div>

      <StatesTable drill={drill} />
      <noscript>
        <style>{".drill-states{display:block}.drill-play{display:none}"}</style>
      </noscript>

      <figcaption className="drill-foot">
        {terms.source === "example" ? "An example, because no public position could be read. " : `A public position, ${terms.label}: ${usd(terms.debtUsd)} of debt against ${usd(terms.collateralUsd)} of collateral. `}
        Trigger and target are this drill&apos;s settings. Every reading after the first is simulated.{" "}
        {terms.address && (
          <Link href={`/a/${terms.address}`} prefetch={false}>
            Open this position
          </Link>
        )}
      </figcaption>
    </figure>
  );
}
