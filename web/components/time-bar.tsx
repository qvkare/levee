import type { CSSProperties } from "react";
import type { Replay } from "@/lib/proof.ts";
import { Badge, type LaneKey } from "./badge.tsx";

const secs = (ms: number) => (ms < 100 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);

/** The median run's legs, end to end, each as long as it took and in the colour of the line it ran on. */
export function TimeBar({ replay }: { replay: Replay }) {
  const { near, signed, sent, included } = replay.marks;
  const legs: Array<{ lane: LaneKey; label: string; ms: number }> = [
    { lane: "N", label: "Detection to the rescue call on NEAR", ms: near },
    { lane: "M", label: "MPC signature", ms: signed - near },
    { lane: "K", label: "Signer checked and sent", ms: sent - signed },
    { lane: "P", label: "Repay included", ms: included - sent },
  ];
  return (
    <aside className="time-card" aria-labelledby="time-card-h">
      <h3 id="time-card-h">Where the time goes</h3>
      <p>
        The run the home page replays took {secs(included)}, the median of the landed runs. Each leg is drawn to its length.
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
