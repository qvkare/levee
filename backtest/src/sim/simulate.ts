// The rescue model. Pure functions over a position's path, with no I/O, so the tests can
// check it against hand-worked numbers.
//
// Names follow the brief: trigger T, target G, reserve R, delay D. docs/SPEC.md section 5
// writes the same repay formula with T for the target: amount = debt - capacity / target.

/** One observation of a position. `capacity` is collateral × liquidation threshold, in USD. */
export interface PathPoint {
  /** Unix seconds. */
  t: number;
  block: number;
  capacity: number;
  /** Total debt, USD. */
  debt: number;
}

export interface PositionPath {
  /**
   * Ascending in time. Points with `block < liquidationBlock` are observed. Points from
   * `liquidationBlock` on hold the pre-liquidation portfolio frozen against later prices.
   * The first of them must sit at the liquidation itself.
   */
  points: PathPoint[];
  liquidationBlock: number;
  liquidationTime: number;
  /** Share of total debt that USDC can repay, from 0 to 1. */
  usdcShare: number;
}

export interface Params {
  trigger: number;
  target: number;
  /** Reserve as a share of debt at arming. */
  reserveShare: number;
  delaySec: number;
  cooldownSec: number;
}

export type Reason =
  | 'saved'
  /** HF was never below the trigger in any observation before the liquidation block. */
  | 'no_warning'
  /** HF crossed the trigger, but the repay would land at or after the real liquidation. */
  | 'too_slow'
  /** Repays landed, the reserve ran out, and HF still fell below 1. */
  | 'reserve_empty'
  /** Repays landed, USDC debt ran out, and HF still fell below 1. */
  | 'usdc_debt_exhausted'
  /** Repays landed and reserve remained, but the next repay was still in flight when HF fell below 1. */
  | 'follow_up_too_slow';

export type FailurePhase = 'at_real_liquidation' | 'later_in_window';

export interface Landing {
  detectedAt: number;
  landedAt: number;
  amount: number;
}

export interface Outcome {
  saved: boolean;
  reason: Reason;
  phase: FailurePhase | null;
  reserve: number;
  /** USD actually landed before the end of the run. */
  repaid: number;
  landings: Landing[];
  /** First observation with HF below the trigger, or null. */
  firstDetection: number | null;
  /** HF was already below the trigger when the position was armed. */
  armedBelowTrigger: boolean;
  /** Lowest HF seen from the real liquidation to the end of the window. */
  minHfFromLiquidation: number;
}

export const healthFactor = (capacity: number, debt: number): number => (debt <= 0 ? Infinity : capacity / debt);

/** The spec's repay formula, floored at zero. */
export const repayToTarget = (capacity: number, debt: number, target: number): number => Math.max(0, debt - capacity / target);

const EPSILON = 1e-9;

/** The debt the reserve is sized on: the first observation with debt, at or after arming. */
export function armingPoint(path: PositionPath): PathPoint {
  const first = path.points.find((p) => p.debt > 0);
  if (!first) throw new Error('path has no debt');
  return first;
}

export function simulate(path: PositionPath, params: Params): Outcome {
  const arming = armingPoint(path);
  const reserve = params.reserveShare * arming.debt;
  const armedBelowTrigger = healthFactor(arming.capacity, arming.debt) < params.trigger;

  let unspent = reserve;
  let landed = 0;
  let inFlight: Landing | null = null;
  let lastFire = -Infinity;
  const landings: Landing[] = [];

  let firstDetection: number | null = null;
  let minHf = Infinity;
  let failedAt: PathPoint | null = null;

  for (const point of path.points) {
    if (point.t < arming.t) continue;
    // Strict: a repay landing at the same instant as an observation counts from the next
    // one, so a tie with the liquidation goes to the liquidator.
    if (inFlight && inFlight.landedAt < point.t) {
      landings.push(inFlight);
      landed += inFlight.amount;
      inFlight = null;
    }
    const debt = Math.max(0, point.debt - landed);
    const hf = healthFactor(point.capacity, debt);
    const atOrAfterLiquidation = point.block >= path.liquidationBlock;

    if (atOrAfterLiquidation) {
      minHf = Math.min(minHf, hf);
      if (hf < 1) {
        failedAt = point;
        break;
      }
    }

    if (hf < params.trigger) {
      if (firstDetection === null && !atOrAfterLiquidation) firstDetection = point.t;
      const cooled = point.t - lastFire >= params.cooldownSec;
      if (!inFlight && cooled && unspent > EPSILON) {
        const repayable = Math.max(0, path.usdcShare * point.debt - landed);
        const amount = Math.min(repayToTarget(point.capacity, debt, params.target), unspent, repayable);
        if (amount > EPSILON) {
          inFlight = { detectedAt: point.t, landedAt: point.t + params.delaySec, amount };
          unspent -= amount;
          lastFire = point.t;
        }
      }
    }
  }

  const repaid = landings.reduce((sum, l) => sum + l.amount, 0);
  const landedBeforeLiquidation = landings.some((l) => l.landedAt < path.liquidationTime);

  if (!failedAt) {
    return { saved: true, reason: 'saved', phase: null, reserve, repaid, landings, firstDetection, armedBelowTrigger, minHfFromLiquidation: minHf };
  }
  const phase: FailurePhase = failedAt.block <= path.liquidationBlock ? 'at_real_liquidation' : 'later_in_window';
  let reason: Reason;
  if (firstDetection === null) reason = 'no_warning';
  else if (!landedBeforeLiquidation) reason = 'too_slow';
  else if (unspent <= EPSILON) reason = 'reserve_empty';
  else if (repaid >= path.usdcShare * failedAt.debt - EPSILON) reason = 'usdc_debt_exhausted';
  else reason = 'follow_up_too_slow';
  return { saved: false, reason, phase, reserve, repaid, landings, firstDetection, armedBelowTrigger, minHfFromLiquidation: minHf };
}
