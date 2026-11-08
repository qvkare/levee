/** The four lines of a rescue, and the planned one. Each colour is one actor and nothing else. */
export type LaneKey = "P" | "K" | "N" | "M" | "I";

export const LANE_NAMES: Record<LaneKey, string> = {
  P: "Your position",
  K: "Keeper",
  N: "Levee contract",
  M: "MPC network",
  I: "NEAR Intents",
};

/** A line's letter on its colour. Decorative: the name always stands beside it. */
export function Badge({ lane, size = "m" }: { lane: LaneKey; size?: "m" | "s" }) {
  return (
    <span className={`badge b${lane}${size === "s" ? " badge-s" : ""}`} aria-hidden="true">
      {lane}
    </span>
  );
}
