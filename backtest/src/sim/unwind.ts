// Repay from collateral (docs/SPEC.md section 9): the keeper rule of `tracked.ts` with no reserve.
// Each unwind sells one collateral asset for R USDC on Uniswap v3 and repays R, in one
// transaction that lands D seconds after detection. Pure: the price of an unwind comes from an
// `Executor`, so the tests can hand-work it and the run can read committed quotes.
//
// Rules are in README.md, "Method: repay from collateral".

/** A path with the sold asset's price, units and threshold at every point. Columns, not objects, because paths have every observation. */
export interface CollateralPath {
  n: number;
  /** Unix seconds, ascending. */
  t: Float64Array;
  block: Float64Array;
  /** Collateral × liquidation threshold, USD, with no Levee. */
  capacity: Float64Array;
  /** Total debt, USD, with no Levee. */
  debt: Float64Array;
  /** The part of `debt` that native USDC can repay, USD. */
  usdcDebt: Float64Array;
  /** AaveOracle USD price of the asset the position sells. */
  price: Float64Array;
  /** Units of that asset counting as collateral on the path. */
  units: Float64Array;
  /** Its liquidation threshold at this point, under the position's eMode. */
  lt: Float64Array;
  /** The real first liquidation in the period, or null. */
  liquidation: { block: number; t: number } | null;
}

export interface UnwindParams {
  trigger: number;
  target: number;
  delaySec: number;
  cooldownSec: number;
  slippageBps: number;
  /** The configured tier's fee as a fraction, 0.0005 for the 500 tier. Sizing adds it to the slippage cap. */
  sizingFee: number;
  minUnwindUsd: number;
}

export type UnwindStatus = 'landed' | 'cap' | 'liquidity';

/** What an unwind did at its landing block. */
export interface Execution {
  status: UnwindStatus;
  block: number;
  /** Fee tier used, or 0 when it reverted. */
  fee: number;
  /** Units of the sold asset paid. Zero unless landed. */
  units: number;
  /** AaveOracle value of the collateral paid, USD. Zero unless landed. */
  paidUsd: number;
  /** AaveOracle value of the USDC received, USD. Zero unless landed. */
  receivedUsd: number;
  /** The part of paid − received due to the pool's price before the swap differing from the oracle. */
  gapUsd: number;
  /** Gas, paid whether it landed or reverted. */
  gasUsd: number;
  /** A repeat revert taken from the run's last quoted unwind, not quoted itself. */
  standIn?: boolean;
}

export interface UnwindRequest {
  detectedAt: number;
  landsAt: number;
  /** USDC to receive and repay. */
  amount: number;
  /** AaveOracle price of the sold asset at detection. Only a fetch round's guess uses it. */
  price: number;
}

/** Prices an unwind. The offline run throws if a quote is not in the committed files. */
export type Executor = (request: UnwindRequest) => Execution;

export interface Attempt extends UnwindRequest {
  /** The asset left set the size: R was cut to what remained of it. */
  cutByCollateral: boolean;
  /** Null when the unwind was still in flight when the run stopped. */
  execution: Execution | null;
}

export type CollateralReason =
  | 'saved'
  /** No collateral of the position has a usable pool. Nothing is ever sent. */
  | 'no_pool'
  /** HF was never below T in any observation before the liquidation block. */
  | 'no_warning'
  /** An unwind reverted, on the cap or for lack of liquidity, before the position failed. */
  | 'slippage_cap'
  /** HF crossed T, but every unwind the rule asked for before the failure was under the $1 floor. */
  | 'under_minimum'
  /** Nothing landed before the real liquidation. */
  | 'too_slow'
  /** The chosen asset ran out: it was all sold, or an unwind was cut to what was left. */
  | 'collateral_exhausted'
  /** Unwinds landed, all USDC debt was repaid, and HF still fell below 1. */
  | 'usdc_debt_exhausted'
  /** The next unwind was in flight or cooling down when HF fell below 1. */
  | 'follow_up_too_slow';

export interface UnwindOutcome {
  /** Not liquidated in reality, or an unwind landed first and HF held at or above 1 to the end. */
  saved: boolean;
  /** Null when the position was not liquidated in reality. */
  reason: CollateralReason | null;
  armedBelowTrigger: boolean;
  firstDetection: number | null;
  attempts: Attempt[];
  sent: number;
  landed: number;
  reverted: number;
  /** Sent, but still in flight when the run stopped. Its gas and swap are left out. */
  unresolved: number;
  repaidUsd: number;
  soldUnits: number;
  /** Oracle value of the collateral sold, at each sale. */
  soldUsd: number;
  /** Paid minus received, at the oracle, summed over landed unwinds. */
  swapCostUsd: number;
  gapUsd: number;
  gasUsd: number;
}

const EPSILON = 1e-9;

export function collateralArming(path: CollateralPath): number {
  for (let i = 0; i < path.n; i++) if (path.debt[i]! > 0) return i;
  throw new Error('path has no debt');
}

/** R to reach `target`, from the spec: (G × D − CL) / (G − L_c × (1 + s)). */
export function unwindToTarget(capacity: number, debt: number, target: number, lt: number, s: number): number {
  return Math.max(0, (target * debt - capacity) / (target - lt * (1 + s)));
}

export function simulateUnwind(path: CollateralPath, params: UnwindParams, execute: Executor): UnwindOutcome {
  const arm = collateralArming(path);
  const armedBelowTrigger = path.capacity[arm]! / path.debt[arm]! < params.trigger;
  const s = params.sizingFee + params.slippageBps / 1e4;
  const liquidation = path.liquidation;

  let landed = 0;
  let sold = 0;
  let inFlight: Attempt | null = null;
  let lastFire = -Infinity;
  let firstDetection: number | null = null;
  let failedAt = -1;
  let blockedByCollateral = false;
  const attempts: Attempt[] = [];

  for (let i = arm; i < path.n; i++) {
    const t = path.t[i]!;
    // Strict, as in the reserve mode: an unwind landing at the same instant as an observation
    // counts from the next one, so a tie with the liquidation goes to the liquidator.
    if (inFlight && inFlight.landsAt < t) {
      const execution = execute(inFlight);
      inFlight.execution = execution;
      attempts.push(inFlight);
      if (execution.status === 'landed') {
        landed += inFlight.amount;
        sold += execution.units;
      }
      inFlight = null;
    }
    const usdcDebt = path.usdcDebt[i]!;
    const units = path.units[i]!;
    const price = path.price[i]!;
    const lt = path.lt[i]!;
    // A landed repay counts only up to the USDC debt on the path, and sold units only up to the
    // units on the path: a borrower who later repaid or withdrew itself had less of either.
    const debt = Math.max(0, path.debt[i]! - Math.min(landed, usdcDebt));
    const capacity = Math.max(0, path.capacity[i]! - Math.min(sold, units) * price * lt);
    const hf = debt > 0 ? capacity / debt : Infinity;
    const atOrAfterLiquidation = liquidation !== null && path.block[i]! >= liquidation.block;
    if (atOrAfterLiquidation && (hf < 1 || landed === 0)) {
      failedAt = i;
      break;
    }
    if (hf < params.trigger) {
      if (firstDetection === null && !atOrAfterLiquidation) firstDetection = t;
      if (!inFlight && t - lastFire >= params.cooldownSec) {
        const need = unwindToTarget(capacity, debt, params.target, lt, s);
        const repayable = Math.max(0, usdcDebt - landed);
        const left = (Math.max(0, units - sold) * price) / (1 + s);
        const wanted = Math.min(need, repayable);
        const amount = Math.min(wanted, left);
        if (amount >= params.minUnwindUsd) {
          inFlight = { detectedAt: t, landsAt: t + params.delaySec, amount, price, cutByCollateral: left < wanted, execution: null };
          lastFire = t;
        } else if (left < wanted) {
          blockedByCollateral = true;
        }
      }
    }
  }
  if (inFlight) attempts.push(inFlight);

  const outcome: UnwindOutcome = {
    saved: true,
    reason: null,
    armedBelowTrigger,
    firstDetection,
    attempts,
    sent: attempts.length,
    landed: 0,
    reverted: 0,
    unresolved: 0,
    repaidUsd: 0,
    soldUnits: sold,
    soldUsd: 0,
    swapCostUsd: 0,
    gapUsd: 0,
    gasUsd: 0,
  };
  for (const a of attempts) {
    const e = a.execution;
    if (!e) {
      outcome.unresolved++;
      continue;
    }
    outcome.gasUsd += e.gasUsd;
    if (e.status === 'landed') {
      outcome.landed++;
      outcome.repaidUsd += a.amount;
      outcome.soldUsd += e.paidUsd;
      outcome.swapCostUsd += e.paidUsd - e.receivedUsd;
      outcome.gapUsd += e.gapUsd;
    } else {
      outcome.reverted++;
    }
  }
  if (liquidation === null) return outcome;
  if (failedAt < 0) {
    outcome.reason = 'saved';
    return outcome;
  }
  outcome.saved = false;
  const failT = path.t[failedAt]!;
  const resolved = attempts.filter((a) => a.execution !== null && a.landsAt < failT);
  const sentBeforeFailure = attempts.some((a) => a.detectedAt < failT);
  if (firstDetection === null) outcome.reason = 'no_warning';
  else if (resolved.some((a) => a.execution!.status !== 'landed')) outcome.reason = 'slippage_cap';
  else if (!sentBeforeFailure) outcome.reason = blockedByCollateral ? 'collateral_exhausted' : 'under_minimum';
  else if (!resolved.some((a) => a.execution!.status === 'landed' && a.landsAt < liquidation.t)) outcome.reason = 'too_slow';
  else if (blockedByCollateral || resolved.some((a) => a.cutByCollateral) || sold >= path.units[failedAt]! - EPSILON) outcome.reason = 'collateral_exhausted';
  else if (landed >= path.usdcDebt[failedAt]! - EPSILON) outcome.reason = 'usdc_debt_exhausted';
  else outcome.reason = 'follow_up_too_slow';
  return outcome;
}
