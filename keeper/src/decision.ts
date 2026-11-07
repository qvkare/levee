/**
 * The rescue decision. Pure: no I/O, no clock and no floating point, so the same
 * inputs always give the same answer. `replay` depends on that.
 */

export const WAD = 10n ** 18n;
export const BPS = 10_000n;
export const USDC_UNIT = 10n ** 6n;
export const MAX_UINT256 = 2n ** 256n - 1n;

/**
 * Aave burns scaled debt rounding down and reads the balance rounding up, so a repay
 * of R can remove up to two USDC base units less than R. Without this the formula
 * lands just under the target. Measured on the Base fork: 1.7499999999255 for a
 * target of 1.75, and 1.75000000025 with the buffer. See evm/README.md.
 */
export const REPAY_ROUNDING_UNITS = 2n;

export interface Caps {
  /** The position's `max_per_rescue`, USDC base units. */
  maxPerRescue: bigint;
  /** `max_per_day` less what the current UTC day has spent. */
  remainingToday: bigint;
  /** USDC held by the rescuer. */
  rescuerBalance: bigint;
  /** USDC the rescuer has approved to the Pool. A repay above this reverts. */
  rescuerAllowance: bigint;
  /** Seconds until the contract's cooldown allows another rescue. */
  cooldownRemainingSecs: number;
  paused: boolean;
}

export interface DecisionInput {
  /** Aave health factor, wad. */
  healthFactor: bigint;
  /** Total collateral in Aave's base currency, 8 decimals of USD. */
  collateralBase: bigint;
  /** Total debt in Aave's base currency, 8 decimals of USD. */
  debtBase: bigint;
  /** Weighted liquidation threshold in basis points. */
  liquidationThresholdBps: bigint;
  /** Aave's oracle price for USDC. Not assumed to be $1. */
  usdcPriceBase: bigint;
  /** The borrower's variable USDC debt, base units. Other debt cannot be repaid here. */
  usdcDebt: bigint;
  /** Act below this health factor, wad. */
  trigger: bigint;
  /** Repay up to this health factor, wad. */
  target: bigint;
  caps: Caps;
}

export type NoActionReason =
  | 'invalid_thresholds'
  | 'no_debt'
  | 'healthy'
  | 'paused'
  | 'cooldown'
  | 'oracle_price_zero'
  | 'no_usdc_debt'
  | 'max_per_rescue_zero'
  | 'budget_exhausted'
  | 'rescuer_empty'
  | 'no_allowance';

/** What set the final amount: the target itself, or the cap that cut it down. */
export type AmountLimit =
  | 'target'
  | 'debt'
  | 'max_per_rescue'
  | 'max_per_day'
  | 'rescuer_balance'
  | 'allowance';

export type Decision =
  | {
      action: 'none';
      reason: NoActionReason;
      /** True when the position needs a rescue and something stopped it. */
      blocked: boolean;
    }
  | {
      action: 'repay';
      /** USDC base units to send to `rescue`. */
      amount: bigint;
      /** USDC base units the target asked for, before caps. */
      needed: bigint;
      limitedBy: AmountLimit;
      /** Health factor the amount should produce at current prices, wad. */
      projectedHealthFactor: bigint;
    };

const none = (reason: NoActionReason, blocked: boolean): Decision => ({
  action: 'none',
  reason,
  blocked,
});

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/**
 * Spec section 5, `R = D - (C * L) / T`, in USDC base units.
 *
 * The supported debt rounds down and the USDC conversion rounds up, so both round
 * towards repaying more. Returns zero when the position already meets the target.
 */
export function repayToTarget(input: {
  collateralBase: bigint;
  debtBase: bigint;
  liquidationThresholdBps: bigint;
  usdcPriceBase: bigint;
  target: bigint;
}): bigint {
  const { collateralBase, debtBase, liquidationThresholdBps, usdcPriceBase, target } = input;
  const supportedDebtBase = (collateralBase * liquidationThresholdBps * WAD) / (BPS * target);
  if (debtBase <= supportedDebtBase) return 0n;
  const repayBase = debtBase - supportedDebtBase;
  return ceilDiv(repayBase * USDC_UNIT, usdcPriceBase) + REPAY_ROUNDING_UNITS;
}

interface Limit {
  limit: AmountLimit;
  value: bigint;
  /** Why a zero here stops the rescue. */
  whenZero?: NoActionReason;
}

function applyCaps(input: DecisionInput, needed: bigint): Decision {
  const { caps, usdcDebt } = input;
  const limits: Limit[] = [
    { limit: 'target', value: needed },
    { limit: 'debt', value: usdcDebt },
    { limit: 'max_per_rescue', value: caps.maxPerRescue, whenZero: 'max_per_rescue_zero' },
    { limit: 'max_per_day', value: caps.remainingToday, whenZero: 'budget_exhausted' },
    { limit: 'rescuer_balance', value: caps.rescuerBalance, whenZero: 'rescuer_empty' },
    { limit: 'allowance', value: caps.rescuerAllowance, whenZero: 'no_allowance' },
  ];

  for (const { value, whenZero } of limits) {
    if (value <= 0n && whenZero) return none(whenZero, true);
  }

  // Ties go to the earliest entry, so 'target' only reads as the limit when no cap bit.
  const smallest = limits.reduce((low, next) => (next.value < low.value ? next : low));
  return {
    action: 'repay',
    amount: smallest.value,
    needed,
    limitedBy: smallest.limit,
    projectedHealthFactor: projectHealthFactor(input, smallest.value),
  };
}

/** Health factor after repaying `amount` at the input's prices. */
export function projectHealthFactor(
  input: Pick<
    DecisionInput,
    'collateralBase' | 'debtBase' | 'liquidationThresholdBps' | 'usdcPriceBase'
  >,
  amount: bigint,
): bigint {
  const repaidBase = (amount * input.usdcPriceBase) / USDC_UNIT;
  if (repaidBase >= input.debtBase) return MAX_UINT256;
  const debtAfter = input.debtBase - repaidBase;
  return (input.collateralBase * input.liquidationThresholdBps * WAD) / (BPS * debtAfter);
}

/** Checks the contract applies anyway. Failing them here saves a wasted NEAR call. */
function precheck(input: DecisionInput): Decision | null {
  if (input.caps.paused) return none('paused', true);
  if (input.caps.cooldownRemainingSecs > 0) return none('cooldown', false);
  if (input.usdcPriceBase <= 0n) return none('oracle_price_zero', true);
  if (input.usdcDebt <= 0n) return none('no_usdc_debt', true);
  return null;
}

/** The decision for one position at one moment. */
export function decide(input: DecisionInput): Decision {
  // A target at or below the trigger would rescue, stay below the trigger and repeat.
  if (input.target <= input.trigger) return none('invalid_thresholds', true);
  if (input.debtBase <= 0n) return none('no_debt', false);
  if (input.healthFactor >= input.trigger) return none('healthy', false);

  const stopped = precheck(input);
  if (stopped) return stopped;

  const needed = repayToTarget(input);
  if (needed <= 0n) return none('healthy', false);
  return applyCaps(input, needed);
}

/**
 * `rescue-once --amount`. The keeper may fire early (spec section 2), so the health
 * factor is not consulted, but the contract's own rules and every cap still apply.
 */
export function decideManual(input: DecisionInput, amount: bigint): Decision {
  if (input.debtBase <= 0n) return none('no_debt', false);
  const stopped = precheck(input);
  if (stopped) return stopped;
  return applyCaps(input, amount);
}

export interface PositionBudget {
  maxPerDay: bigint;
  spentToday: bigint;
  /** The contract's day bucket: days since the Unix epoch, UTC. */
  day: bigint;
  cooldownSecs: number;
  /** Nanoseconds since the Unix epoch, as stored by the contract. */
  lastRescueAtNs: bigint;
}

const MS_PER_DAY = 86_400_000;

/** Daily budget left, resetting when the contract's stored day is no longer today. */
export function remainingToday(position: PositionBudget, nowMs: number): bigint {
  const today = BigInt(Math.floor(nowMs / MS_PER_DAY));
  const spent = position.day === today ? position.spentToday : 0n;
  return spent >= position.maxPerDay ? 0n : position.maxPerDay - spent;
}

/** Seconds of cooldown left. A position that has never rescued has none. */
export function cooldownRemainingSecs(position: PositionBudget, nowMs: number): number {
  if (position.lastRescueAtNs === 0n) return 0;
  const elapsedNs = BigInt(nowMs) * 1_000_000n - position.lastRescueAtNs;
  const elapsedSecs = elapsedNs <= 0n ? 0 : Number(elapsedNs / 1_000_000_000n);
  return Math.max(0, position.cooldownSecs - elapsedSecs);
}

/** Parses a decimal such as "1.25" into wad. */
export function parseWad(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,18}))?$/.exec(value.trim());
  if (!match) throw new Error(`not a decimal with at most 18 places: ${value}`);
  const whole = BigInt(match[1] ?? '0');
  const fraction = (match[2] ?? '').padEnd(18, '0');
  return whole * WAD + BigInt(fraction === '' ? '0' : fraction);
}

/**
 * Renders a wad as a decimal string, truncated to `places` and without trailing zeros.
 * Aave reports `uint256.max` for an account with no debt, which has no meaningful
 * decimal, so that value renders as "no_debt".
 */
export function formatWad(value: bigint, places = 6): string {
  if (value === MAX_UINT256) return 'no_debt';
  const scale = 10n ** BigInt(18 - places);
  const truncated = value / scale;
  const unit = 10n ** BigInt(places);
  const whole = truncated / unit;
  const fraction = (truncated % unit).toString().padStart(places, '0').replace(/0+$/, '');
  return fraction === '' ? whole.toString() : `${whole}.${fraction}`;
}
