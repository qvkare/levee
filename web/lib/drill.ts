/**
 * The flood drill, as data. Every figure is computed here from a position's own terms, using the
 * same functions as /api/risk. Nothing here is a measured time: hold times only pace the replay.
 */
import { integer, percent, stageValue, usd } from "./format.ts";
import { healthAfterRepay, liquidate, repayToTarget, type Debtor, type Liquidation } from "./math.ts";

/** One simulated reading every 160 ms. */
export const ROUND_MS = 160;
const READING_HOLD_MS = 1600;
const TRIGGER_HOLD_MS = 700;
const HOP_HOLD_MS = 1100;
const PASSED_HOLD_MS = 500;
const FLOOD_HOLD_MS = 1000;
const LIQUIDATING_HOLD_MS = 900;
const ROUNDS_TO_TRIGGER = 36;

export const DRILL_TRIGGER = 1.2;
export const DRILL_TARGET = 1.5;

export interface DrillTerms {
  /** live: read a moment ago. built: read when this page was built. example: no read succeeded. */
  source: "live" | "built" | "example";
  label: string;
  address: string | null;
  blockNumber: string | null;
  collateralUsd: number;
  debtUsd: number;
  liquidationThreshold: number;
  liquidationBonus: number;
  /** Variable USDC debt, the only debt Levee repays. */
  usdcDebtUsd: number;
  trigger: number;
  target: number;
}

/** Used only when no position could be read, and always marked as an example. */
export const EXAMPLE_TERMS: DrillTerms = {
  source: "example",
  label: "Example position",
  address: null,
  blockNumber: null,
  collateralUsd: 60_000,
  debtUsd: 30_000,
  liquidationThreshold: 0.8,
  liquidationBonus: 0.05,
  usdcDebtUsd: 30_000,
  trigger: DRILL_TRIGGER,
  target: DRILL_TARGET,
};

export type Branch = "with" | "without";
export type DrillPhase = "reading" | "falling" | "trigger" | "detected" | "signed" | "repaid" | "passed" | "flood" | "liquidating" | "liquidated";

export interface DrillFrame {
  phase: DrillPhase;
  /** How long this frame stays before the next one. The last frame stays. */
  holdMs: number;
  /** Simulated round. Zero is the reading itself. */
  round: number;
  /** Fraction of collateral value lost so far. */
  fall: number;
  collateralUsd: number;
  debtUsd: number;
  health: number;
  /** Hops lit in the strip, 0 to 3. */
  hops: number;
  over: boolean;
  caption: string;
}

export interface DrillRun {
  frames: DrillFrame[];
  repaidUsd: number;
  liquidation: Liquidation | null;
}

const healthOf = ({ collateralUsd, liquidationThreshold, debtUsd }: Debtor) => (collateralUsd * liquidationThreshold) / debtUsd;

export function totalMs(run: DrillRun): number {
  return run.frames.reduce((total, frame) => total + frame.holdMs, 0);
}

export function buildDrill(terms: DrillTerms): Record<Branch, DrillRun> {
  const { collateralUsd, debtUsd, liquidationThreshold, liquidationBonus, usdcDebtUsd, target } = terms;
  const startHealth = healthOf(terms);
  // A position that starts near the default trigger still needs some way to fall.
  const trigger = Math.min(terms.trigger, 1 + (startHealth - 1) / 2);
  const fallToTrigger = 1 - trigger / startHealth;
  const step = fallToTrigger / ROUNDS_TO_TRIGGER;

  const at = (phase: DrillPhase, holdMs: number, round: number, fall: number, caption: string, hops = 0): DrillFrame => {
    const collateral = collateralUsd * (1 - fall);
    const health = healthOf({ collateralUsd: collateral, liquidationThreshold, debtUsd });
    return { phase, holdMs, round, fall, collateralUsd: collateral, debtUsd, health, hops, over: health < 1, caption };
  };

  const where = terms.source === "example" ? "An example position." : `${terms.label}, read at block ${integer(terms.blockNumber ?? 0)}.`;
  const reading = at("reading", READING_HOLD_MS, 0, 0, `${where} Health factor ${stageValue(startHealth)}. Now the price falls.`);

  const toTrigger: DrillFrame[] = [];
  for (let round = 1; round <= ROUNDS_TO_TRIGGER; round += 1) {
    toTrigger.push(at("falling", ROUND_MS, round, step * round, "Each round the keeper reads health factor again. The water rises."));
  }
  const atTrigger = toTrigger[toTrigger.length - 1] as DrillFrame;

  // With Levee: the repay is taken at the trigger's price, and only USDC debt can be repaid.
  const fallen: Debtor = { collateralUsd: atTrigger.collateralUsd, liquidationThreshold, debtUsd };
  const needed = repayToTarget(fallen, target);
  const repaidUsd = Math.min(needed, usdcDebtUsd);
  const after = healthAfterRepay(fallen, repaidUsd) ?? target;
  const repaid: DrillFrame = {
    ...atTrigger,
    phase: "repaid",
    holdMs: 0,
    debtUsd: debtUsd - repaidUsd,
    health: after,
    hops: 3,
    caption: `${usd(repaidUsd)} of USDC from the reserve repays the debt. Health factor ${stageValue(after)}. No collateral was sold and no bonus was paid.`,
  };
  const withLevee: DrillFrame[] = [
    reading,
    ...toTrigger,
    { ...atTrigger, phase: "trigger", holdMs: TRIGGER_HOLD_MS, caption: `Health factor crosses the trigger at ${trigger.toFixed(2)}, after a fall of ${percent(fallToTrigger)}.` },
    { ...atTrigger, phase: "detected", holdMs: HOP_HOLD_MS, hops: 1, caption: `The RPC endpoints agree, and the keeper asks the contract to repay ${usd(repaidUsd)}.` },
    { ...atTrigger, phase: "signed", holdMs: HOP_HOLD_MS, hops: 2, caption: "The contract checks the caps and signs. The keeper supplies no calldata." },
    repaid,
  ];

  // Without Levee: the same path carries on, in the same steps, until the first reading below 1.00.
  const onward: DrillFrame[] = [];
  let round = ROUNDS_TO_TRIGGER;
  let frame = atTrigger;
  while (frame.health >= 1) {
    round += 1;
    frame = at("falling", ROUND_MS, round, step * round, "Nothing stands in the way. The water keeps rising.");
    onward.push(frame);
  }
  const liquidation = liquidate({ collateralUsd: frame.collateralUsd, liquidationThreshold, debtUsd }, liquidationBonus);
  const flooded = frame;
  const withoutLevee: DrillFrame[] = [
    reading,
    ...toTrigger,
    { ...atTrigger, phase: "passed", holdMs: PASSED_HOLD_MS, caption: `The water passes ${trigger.toFixed(2)}. There is no keeper and no reserve, so nothing fires.` },
    ...onward,
    { ...flooded, phase: "flood", holdMs: FLOOD_HOLD_MS, hops: 1, caption: `Health factor ${stageValue(flooded.health)} is below 1.00. Liquidators can act now.` },
    { ...flooded, phase: "liquidating", holdMs: LIQUIDATING_HOLD_MS, hops: 2, caption: `A liquidator repays ${usd(liquidation.repaidUsd)} of the debt.` },
    {
      ...flooded,
      phase: "liquidated",
      holdMs: 0,
      collateralUsd: liquidation.collateralLeftUsd,
      debtUsd: liquidation.debtLeftUsd,
      health: liquidation.healthAfter ?? flooded.health,
      hops: 3,
      over: true,
      caption: `A liquidator repaid ${usd(liquidation.repaidUsd)} and took ${usd(liquidation.takenUsd)} of collateral. ${usd(liquidation.bonusUsd)} of that is the ${percent(liquidationBonus)} bonus, paid by the borrower.`,
    },
  ];

  return { with: { frames: withLevee, repaidUsd, liquidation: null }, without: { frames: withoutLevee, repaidUsd: 0, liquidation } };
}

const KEY_STATES: Record<Branch, DrillPhase[]> = {
  with: ["reading", "trigger", "repaid"],
  without: ["reading", "flood", "liquidated"],
};

/** The states that stand in for the drill when motion is off. */
export function keyFrames(run: DrillRun, branch: Branch): DrillFrame[] {
  return KEY_STATES[branch].map((phase) => run.frames.find((frame) => frame.phase === phase) as DrillFrame);
}

export interface Hop {
  name: string;
  detail: string;
}

/** Timings stay "not yet measured" until real runs exist. They are not to be estimated here. */
export function hopsFor(branch: Branch, run: DrillRun): Hop[] {
  if (branch === "with") {
    return [
      { name: "Detected", detail: "not yet measured" },
      { name: "Contract signs", detail: "not yet measured" },
      { name: "Repay lands", detail: "not yet measured" },
    ];
  }
  const taken = run.liquidation;
  return [
    { name: "Over flood stage", detail: "below 1.00" },
    { name: "Liquidator repays", detail: taken ? usd(taken.repaidUsd) : "" },
    { name: "Liquidator takes", detail: taken ? `${usd(taken.takenUsd)} of collateral` : "" },
  ];
}
