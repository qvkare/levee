import type { CSSProperties } from "react";
import { seconds } from "@/lib/format.ts";
import type { Replay } from "@/lib/proof.ts";
import { Badge, type LaneKey } from "./badge.tsx";

const secs = (ms: number) => (ms < 100 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);

/** The replayed run's legs, end to end, each as long as it took and in the colour of the line it ran on. */
export function TimeBar({ replay, median }: { replay: Replay; median: { p50Ms: number | null; samples: number } }) {
  const { near, signed, sent, included } = replay.marks;
  const legs: Array<{ lane: LaneKey; label: string; ms: number }> = [
    { lane: "N", label: "Detection to the rescue call on NEAR", ms: near },
    { lane: "M", label: "MPC signature", ms: signed - near },
    { lane: "K", label: "Signer checked and sent", ms: sent - signed },
    { lane: "P", label: replay.mode === "collateral" ? "Unwind included on Base" : "Repay included", ms: included - sent },
  ];
  const which = replay.chosen === "keyless" ? "The run the home page replays, made after the contracts lost their last keys," : "The run the home page replays";
  const versus = median.p50Ms === null ? "" : ` The median of the ${median.samples} rescues from collateral is ${seconds(median.p50Ms)}.`;
  return (
    <aside className="time-card" aria-labelledby="time-card-h">
      <h3 id="time-card-h">Where the time goes</h3>
      <p>
        {which} took {secs(included)}.{versus} Each leg is drawn to its length.
      </p>
      <div className="time-bar" aria-hidden="true">
        {legs.map((leg) => (
          <span key={leg.lane + leg.label} className={`c-${leg.lane}`} style={{ flexGrow: Math.max(leg.ms, 1) } as CSSProperties} />
        ))}
      </div>
      <ul>
        {legs.map((leg) => (
          <li key={leg.label}>
            <Badge lane={leg.lane} size="s" />
            <span>{leg.label}</span>
            <b>{secs(leg.ms)}</b>
          </li>
        ))}
      </ul>
    </aside>
  );
}
