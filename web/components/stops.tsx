import type { ReactNode } from "react";
import { seconds } from "@/lib/format.ts";
import { PROOF, hop } from "@/lib/proof.ts";
import { Badge, LANE_NAMES, type LaneKey } from "./badge.tsx";

interface Stop {
  lane: LaneKey;
  title: string;
  /** The home page's line. */
  short: string;
  /** The full line on /how. */
  long: string;
  where: string;
  /** The measured hop that ends at this stop. */
  hop?: { id: "near" | "mpc" | "evm"; label: string };
  planned?: boolean;
}

const STOPS: Stop[] = [
  {
    lane: "K",
    title: "Reads health factor",
    short: "Every 5 seconds, from two RPCs. Acts only when they agree within 0.5% and the reads are under 30 seconds old.",
    long: "Every 5 seconds, from at least two RPC endpoints on Base or Arbitrum. It acts only when they agree within 0.5% and the reads are under 30 seconds old. One of the testnet runs stopped here, because two RPCs disagreed.",
    where: "Off chain",
  },
  {
    lane: "K",
    title: "Sizes the repay",
    short: "Below your trigger, it works out the repay that reaches your target, capped by reserve, allowance and USDC debt.",
    long: "Below your trigger, it works out the repay that brings health factor back to your target: R = D - (C * L) / T. The amount is capped by your per-rescue cap, the rescuer's USDC and allowance, and your USDC debt. It reads the rescuer's nonce and fees.",
    where: "Off chain",
  },
  {
    lane: "N",
    title: "Checks your caps",
    short: "Per-rescue cap, daily cap, cooldown, fee ceilings. Then it writes the transaction itself.",
    long: "The keeper calls rescue with a key that can do nothing else. It sends a position id, an amount and fees. The contract checks the per-rescue cap, the daily cap, the cooldown and the fee ceilings, then writes the transaction itself.",
    where: "NEAR",
    hop: { id: "near", label: "to NEAR" },
  },
  {
    lane: "M",
    title: "Signs it",
    short: "Chain Signatures sign for the rescuer address derived for your position.",
    long: "The contract asks the MPC network to sign for the rescuer address derived for your position, path levee/v1/{id}. Most of a rescue's time is spent here.",
    where: "NEAR Chain Signatures",
    hop: { id: "mpc", label: "to signature" },
  },
  {
    lane: "P",
    title: "Repay lands",
    short: "The keeper checks the signer and broadcasts. Aave applies the USDC to your debt. Collateral stays put.",
    long: "The keeper checks that the signature recovers to the rescuer, and broadcasts to two RPCs. Aave applies the USDC to your debt. Your collateral stays where it is, in your wallet's position.",
    where: "Base or Arbitrum",
    hop: { id: "evm", label: "to inclusion" },
  },
  {
    lane: "K",
    title: "Writes the record",
    short: "Every attempt, landed or not, goes to the evidence folder with its timings.",
    long: "The keeper reads health factor again and writes the run to the evidence folder with its timings and transactions, whether it landed or not. The proof page is built from those files.",
    where: "Evidence",
  },
  {
    lane: "I",
    title: "Reserve refills",
    short: "Planned: USDC held off the lending chain returns to the rescuer, to pinned destinations only. Needs partner access.",
    long: "Planned and not built. In the Reserve phase, USDC held off the lending chain goes back to the rescuer through NEAR Intents, to pinned destinations only. It needs partner access. Until then the rescuer holds the USDC it repays with.",
    where: "Planned",
    planned: true,
  },
];

function timeOf(stop: Stop): string | null {
  if (!stop.hop) return null;
  const p50 = hop(PROOF, stop.hop.id)?.p50Ms;
  return p50 == null ? null : `${seconds(p50)} ${stop.hop.label}`;
}

/** The line every rescue runs, as a row of stops. */
export function StopStrip() {
  return (
    <ol className="strip">
      {STOPS.map((stop, index) => {
        const time = timeOf(stop);
        return (
          <li key={stop.title} className={`stop c-${stop.lane}${stop.planned ? " plan" : ""}`}>
            <span className="track" aria-hidden="true" />
            <span className="dot" aria-hidden="true">
              {index + 1}
            </span>
            <p className="who">
              <Badge lane={stop.lane} />
              {LANE_NAMES[stop.lane]}
            </p>
            <h3>{stop.title}</h3>
            <p>{stop.short}</p>
            {time && <p className="time">{time}</p>}
          </li>
        );
      })}
    </ol>
  );
}

/** The same line run down the page, with every stop in full. `after` puts something under a stop. */
export function StopLine({ after }: { after?: Record<number, ReactNode> }) {
  return (
    <ol className="line-v">
      {STOPS.map((stop, index) => {
        const time = timeOf(stop);
        const row = stop.hop ? hop(PROOF, stop.hop.id) : null;
        return (
          <li key={stop.title} className={`stop-v c-${stop.lane}${stop.planned ? " plan" : ""}`}>
            <span className="track" aria-hidden="true" />
            <span className="dot" aria-hidden="true">
              {index + 1}
            </span>
            <p className="who">
              <Badge lane={stop.lane} />
              {LANE_NAMES[stop.lane]} <span className="where">· {stop.where}</span>
            </p>
            <h3>{stop.title}</h3>
            <p>{stop.long}</p>
            {time && row && (
              <p className="time">
                {time}, median of {row.samples}. Slowest {seconds(row.slowestMs ?? 0)}.
              </p>
            )}
            {after?.[index]}
          </li>
        );
      })}
    </ol>
  );
}

export function Terminus() {
  return (
    <div className="terminus">
      <p className="lab">One terminus</p>
      <code>Pool.repay(USDC, amount, 2, borrower)</code>
      <p>The only call the contract builds for a rescue. The keeper sends a position id, an amount and fees, and the borrower is fixed at registration.</p>
    </div>
  );
}

export function stopsIntro(): string {
  const landed = PROOF.overall.samples;
  return landed > 0
    ? `Every rescue runs the same line. Times are medians from the ${landed} testnet runs that landed. The dashed stop is planned and not built.`
    : "Every rescue runs the same line. The dashed stop is planned and not built.";
}
