import { Fragment, type ReactNode } from "react";
import { countWord, seconds } from "@/lib/format.ts";
import { PROOF, hop, type Mode } from "@/lib/proof.ts";
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
  /** The helper's stop, drawn square like the terminus it is. */
  helper?: boolean;
}

/** Collateral runs the keeper stopped itself, because the quote was past the borrower's bound. */
function refusedOnBound(): number {
  return PROOF.runs.filter((run) => run.mode === "collateral" && run.outcome === "aborted" && run.reason?.startsWith("quote_over_slippage_bound")).length;
}

function boundRefusal(): string {
  const count = refusedOnBound();
  return count === 0 ? "" : ` ${countWord(count)} testnet ${count === 1 ? "run" : "runs"} stopped here.`;
}

/** The line every rescue from collateral runs, after the borrower set the terms once. */
function collateralStops(): Stop[] {
  return [
    {
      lane: "P",
      title: "You set the terms",
      short: "Once, on the lending chain: authorize LeveeUnwind with your trigger, target, price bound, collateral and pool, and approve a capped amount of its aToken.",
      long: "Once, from your own wallet on the lending chain: authorize(rescuer, maxSlippageBps, triggerHf, targetHf, collateral, poolFee) on LeveeUnwind, and a capped approval of the collateral’s aToken to it. There is no Safe, module or credit delegation. revoke() or a zero allowance stops it at once, without NEAR.",
      where: "Base, once",
    },
    {
      lane: "K",
      title: "Reads health factor",
      short: "Every 5 seconds, from two RPCs. Acts only when they agree within 0.5% and the reads are under 30 seconds old.",
      long: "Every 5 seconds, from at least two RPC endpoints on Base or Arbitrum. It acts only when they agree within 0.5% and the reads are under 30 seconds old. One of the reserve-mode runs stopped here, because two RPCs disagreed.",
      where: "Off chain",
    },
    {
      lane: "K",
      title: "Sizes and quotes the sale",
      short: "Below your trigger, it works out the USDC repay that reaches your target and quotes the sale on Uniswap. Past your bound, it stops.",
      long: `Below your trigger, it works out the USDC repay that brings health factor back to your target, within your caps and your USDC debt, and quotes the sale on Uniswap’s QuoterV2 from every RPC. If the quote is past your price bound against Aave’s oracle, it stops and sends nothing.${boundRefusal()} Otherwise it sets max_sold to the quote plus 0.5%.`,
      where: "Off chain",
    },
    {
      lane: "N",
      title: "Checks your caps",
      short: "Per-rescue cap, daily cap, cooldown, fee ceilings. Then it writes the transaction itself.",
      long: "The keeper calls rescue_from_collateral(id, amount, max_sold, fees) with a key that can do nothing else. It sends no calldata, no target and no payload. The contract checks the per-rescue cap, the daily cap, the cooldown and the fee ceilings, then builds the transaction itself.",
      where: "NEAR",
      hop: { id: "near", label: "to NEAR" },
    },
    {
      lane: "M",
      title: "Signs it",
      short: "Chain Signatures sign LeveeUnwind.unwind for the rescuer address derived for your position.",
      long: "The contract asks the MPC network to sign LeveeUnwind.unwind(borrower, collateral, amount, poolFee, maxSold) from the rescuer address derived for your position, path levee/v1/{id}. The borrower, collateral and pool fee come from your registration. Most of a rescue’s time is spent here.",
      where: "NEAR Chain Signatures",
      hop: { id: "mpc", label: "to signature" },
    },
    {
      lane: "P",
      title: "The helper checks and sells",
      short: "On the lending chain, LeveeUnwind checks your trigger, collateral, pool and bound, repays the USDC and sells just enough collateral.",
      long: "The keeper checks the signer and broadcasts. Anyone could: the signature is public. On the lending chain, LeveeUnwind requires health factor below your trigger, and the collateral and pool you authorized. The pool sends the USDC first; the helper repays your debt, takes the aTokens the pool is owed and withdraws them to the pool. The sale must be within your bound against Aave’s oracle and within max_sold, and health factor must rise without passing far beyond your target.",
      where: "Base or Arbitrum",
      hop: { id: "evm", label: "to inclusion" },
      helper: true,
    },
    {
      lane: "K",
      title: "Writes the record",
      short: "Every attempt, landed or not, goes to the evidence folder with its timings.",
      long: "The keeper reads health factor again and writes the run to the evidence folder with its timings, transactions and the sale, whether it landed or not. The proof page is built from those files.",
      where: "Evidence",
    },
  ];
}

/** The second mode: the same keeper and contract, a repay from USDC held at the rescuer. */
const RESERVE_STOPS: Stop[] = [
  {
    lane: "N",
    title: "Checks your caps",
    short: "",
    long: "The keeper calls rescue(id, amount, fees) with a key that can do nothing else. The repay is R = D - (C * L) / T, capped by the per-rescue cap, the rescuer’s USDC and allowance, and the USDC debt. The contract checks the same caps, cooldown and fee ceilings.",
    where: "NEAR",
    hop: { id: "near", label: "to NEAR" },
  },
  {
    lane: "M",
    title: "Signs Pool.repay",
    short: "",
    long: "The MPC network signs Pool.repay(USDC, amount, 2, borrower) from the rescuer address, which holds the USDC. No collateral moves.",
    where: "NEAR Chain Signatures",
    hop: { id: "mpc", label: "to signature" },
  },
  {
    lane: "P",
    title: "Repay lands",
    short: "",
    long: "The keeper checks the signer and broadcasts. Aave applies the USDC to your debt, and your collateral stays where it is.",
    where: "Base or Arbitrum",
    hop: { id: "evm", label: "to inclusion" },
  },
  {
    lane: "I",
    title: "Reserve refills",
    short: "",
    long: "Planned and not built. USDC held off the lending chain would go back to the rescuer through NEAR Intents, to pinned destinations only. It needs partner access. Until then the rescuer holds the USDC it repays with.",
    where: "Planned",
    planned: true,
  },
];

function timeOf(stop: Stop, mode: Mode): string | null {
  if (!stop.hop) return null;
  const p50 = hop(PROOF, stop.hop.id, mode)?.p50Ms;
  return p50 == null ? null : `${seconds(p50)} ${stop.hop.label}`;
}

const classes = (base: string, stop: Stop) => `${base} c-${stop.lane}${stop.planned ? " plan" : ""}${stop.helper ? " helper" : ""}`;

/** The line every rescue runs, as a row of stops. */
export function StopStrip() {
  return (
    <ol className="strip">
      {collateralStops().map((stop, index) => {
        const time = timeOf(stop, "collateral");
        return (
          <li key={stop.title} className={classes("stop", stop)}>
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

/** A line run down the page, with every stop in full. `after` puts something under a stop. */
export function StopLine({ mode = "collateral", after }: { mode?: Mode; after?: Record<number, ReactNode> }) {
  const stops = mode === "collateral" ? collateralStops() : RESERVE_STOPS;
  return (
    <ol className="line-v">
      {stops.map((stop, index) => {
        const time = timeOf(stop, mode);
        const row = stop.hop ? hop(PROOF, stop.hop.id, mode) : null;
        return (
          <li key={stop.title} className={classes("stop-v", stop)}>
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

/** The call, broken between its arguments so it never breaks inside one. */
function Call({ name, args }: { name: string; args: string[] }) {
  return (
    <code>
      <span>{name}(</span>
      {args.map((arg, index) => (
        <Fragment key={arg}>
          {index === 0 ? "" : " "}
          <span>
            {arg}
            {index === args.length - 1 ? ")" : ","}
          </span>
        </Fragment>
      ))}
    </code>
  );
}

/** The only call a rescue from collateral can make, and what the helper checks before anything moves. */
export function Terminus() {
  return (
    <div className="terminus">
      <p className="lab">One terminus</p>
      <Call name="LeveeUnwind.unwind" args={["borrower", "collateral", "amount", "poolFee", "maxSold"]} />
      <div className="terminus-body">
        <p>The only call a rescue from collateral can make. The keeper sends a position id, an amount, max_sold and fees, and the borrower, collateral and pool are fixed at registration. On the lending chain, before anything moves, the helper checks:</p>
        <ul>
          <li>health factor is below your trigger</li>
          <li>the collateral and pool are the ones you authorized</li>
          <li>the sale is within your bound against Aave’s oracle, and within max_sold</li>
          <li>health factor rose, and did not pass far beyond your target</li>
        </ul>
        <p>LeveeUnwind has no owner and cannot be upgraded.</p>
      </div>
    </div>
  );
}

/** The second mode's terminus. */
export function ReserveTerminus() {
  return (
    <div className="terminus">
      <p className="lab">Reserve terminus</p>
      <Call name="Pool.repay" args={["USDC", "amount", "2", "borrower"]} />
      <div className="terminus-body">
        <p>The only call a rescue from a reserve can make, from USDC held at the rescuer. The keeper sends a position id, an amount and fees, and the borrower is fixed at registration.</p>
      </div>
    </div>
  );
}

export function stopsIntro(): string {
  const landed = PROOF.modes.collateral.timing.overall.samples;
  return landed > 0
    ? `You set the terms once. Then every rescue runs the same line. Times are medians from the ${landed} testnet rescues from collateral. The helper’s stop is square, like the terminus it is.`
    : "You set the terms once. Then every rescue runs the same line.";
}
