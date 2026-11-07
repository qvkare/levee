import { describe, expect, it } from 'vitest';
import {
  type Caps,
  type DecisionInput,
  MAX_UINT256,
  REPAY_ROUNDING_UNITS,
  WAD,
  cooldownRemainingSecs,
  decide,
  decideManual,
  formatWad,
  parseWad,
  projectHealthFactor,
  remainingToday,
  repayToTarget,
} from '../src/decision.js';

const openCaps: Caps = {
  maxPerRescue: 1_000_000n * 10n ** 6n,
  remainingToday: 1_000_000n * 10n ** 6n,
  rescuerBalance: 1_000_000n * 10n ** 6n,
  rescuerAllowance: 1_000_000n * 10n ** 6n,
  cooldownRemainingSecs: 0,
  paused: false,
};

/** $20,000 of collateral at 80% against $14,000 of debt: health factor 1.142857. */
const position = (over: Partial<DecisionInput> = {}): DecisionInput => ({
  healthFactor: 1_142_857_142_857_142_857n,
  collateralBase: 20_000n * 10n ** 8n,
  debtBase: 14_000n * 10n ** 8n,
  liquidationThresholdBps: 8_000n,
  usdcPriceBase: 10n ** 8n,
  usdcDebt: 14_000n * 10n ** 6n,
  trigger: parseWad('1.25'),
  target: parseWad('1.6'),
  caps: openCaps,
  ...over,
});

const expectRepay = (decision: ReturnType<typeof decide>) => {
  if (decision.action !== 'repay') throw new Error(`expected a repay, got ${decision.reason}`);
  return decision;
};

describe('decide: when to act', () => {
  it('does nothing at or above the trigger', () => {
    expect(decide(position({ healthFactor: parseWad('1.25') }))).toEqual({
      action: 'none',
      reason: 'healthy',
      blocked: false,
    });
    expect(decide(position({ healthFactor: parseWad('3') })).action).toBe('none');
  });

  it('acts one wei below the trigger', () => {
    const decision = decide(position({ healthFactor: parseWad('1.25') - 1n }));
    expect(decision.action).toBe('repay');
  });

  it('does nothing for an account with no debt', () => {
    expect(decide(position({ healthFactor: MAX_UINT256, debtBase: 0n, usdcDebt: 0n }))).toEqual({
      action: 'none',
      reason: 'no_debt',
      blocked: false,
    });
  });

  it('refuses a target that does not clear the trigger', () => {
    const atTrigger = position({ target: parseWad('1.25') });
    expect(decide(atTrigger)).toMatchObject({ reason: 'invalid_thresholds', blocked: true });
    const belowTrigger = position({ target: parseWad('1.2') });
    expect(decide(belowTrigger)).toMatchObject({ reason: 'invalid_thresholds', blocked: true });
  });

  it('reports a paused position as blocked', () => {
    const decision = decide(position({ caps: { ...openCaps, paused: true } }));
    expect(decision).toMatchObject({ reason: 'paused', blocked: true });
  });

  it('waits out the cooldown without calling it a failure', () => {
    const decision = decide(position({ caps: { ...openCaps, cooldownRemainingSecs: 1 } }));
    expect(decision).toMatchObject({ reason: 'cooldown', blocked: false });
  });

  it('refuses to divide by a zero oracle price', () => {
    const decision = decide(position({ usdcPriceBase: 0n }));
    expect(decision).toMatchObject({ reason: 'oracle_price_zero', blocked: true });
  });

  it('stands aside when the debt is not USDC', () => {
    const decision = decide(position({ usdcDebt: 0n }));
    expect(decision).toMatchObject({ reason: 'no_usdc_debt', blocked: true });
  });
});

describe('repayToTarget: the spec formula', () => {
  it('solves R = D - (C * L) / T', () => {
    // C * L = 16,000. At T = 1.6 the position supports 10,000 of debt, so R = 4,000.
    expect(repayToTarget(position())).toBe(4_000n * 10n ** 6n + REPAY_ROUNDING_UNITS);
  });

  it('returns zero when the position already meets the target', () => {
    expect(repayToTarget(position({ debtBase: 10_000n * 10n ** 8n }))).toBe(0n);
    expect(repayToTarget(position({ debtBase: 9_000n * 10n ** 8n }))).toBe(0n);
  });

  it('repays the whole debt when no collateral counts', () => {
    const amount = repayToTarget(position({ liquidationThresholdBps: 0n }));
    expect(amount).toBe(14_000n * 10n ** 6n + REPAY_ROUNDING_UNITS);
  });

  it('prices USDC from the oracle rather than assuming a dollar', () => {
    // At $0.50 a USDC, $4,000 of debt takes 8,000 USDC.
    expect(repayToTarget(position({ usdcPriceBase: 5n * 10n ** 7n }))).toBe(
      8_000n * 10n ** 6n + REPAY_ROUNDING_UNITS,
    );
  });

  it('converts the 8-decimal base amount to 6-decimal USDC rounding up', () => {
    // $0.00000001 over at $1 is 0.01 USDC base units, which must round up to 1.
    const amount = repayToTarget(position({ debtBase: 10_000n * 10n ** 8n + 1n }));
    expect(amount).toBe(1n + REPAY_ROUNDING_UNITS);
  });

  it('rounds the supported debt down so the error is on the repay side', () => {
    // C * L * WAD / (BPS * T) = 333.33..., so the supported debt floors to 333.
    const amount = repayToTarget({
      collateralBase: 1_000n,
      debtBase: 334n,
      liquidationThresholdBps: 10_000n,
      usdcPriceBase: 10n ** 8n,
      target: 3n * WAD,
    });
    expect(amount).toBe(1n + REPAY_ROUNDING_UNITS);
  });

  // Inputs and result are printed by test_repayFormula_reachesTarget in evm/. The
  // fork shows this amount carries the live Aave position to at least the target.
  it.each([
    ['Base', 2_246_198_959_119n, 1_257_871_417_110n, 99_975_000n, 1_797_408_522n],
    ['Arbitrum One', 2_246_935_097_709n, 1_258_283_654_750n, 99_987_730n, 1_797_768_667n],
  ])('matches the amount proven on the %s fork', (_chain, collateral, debt, price, expected) => {
    const amount = repayToTarget({
      collateralBase: collateral,
      debtBase: debt,
      liquidationThresholdBps: 8_400n,
      usdcPriceBase: price,
      target: parseWad('1.75'),
    });
    expect(amount).toBe(expected);
  });
});

describe('decide: caps', () => {
  const needed = 4_000n * 10n ** 6n + REPAY_ROUNDING_UNITS;

  it('repays what the target needs when no cap is lower', () => {
    const decision = expectRepay(decide(position()));
    expect(decision.amount).toBe(needed);
    expect(decision.needed).toBe(needed);
    expect(decision.limitedBy).toBe('target');
  });

  it.each([
    ['max_per_rescue', { maxPerRescue: 1_000_000_000n }],
    ['max_per_day', { remainingToday: 1_000_000_000n }],
    ['rescuer_balance', { rescuerBalance: 1_000_000_000n }],
    ['allowance', { rescuerAllowance: 1_000_000_000n }],
  ])('caps the amount at %s', (limitedBy, caps) => {
    const decision = expectRepay(decide(position({ caps: { ...openCaps, ...caps } })));
    expect(decision.amount).toBe(1_000_000_000n);
    expect(decision.needed).toBe(needed);
    expect(decision.limitedBy).toBe(limitedBy);
  });

  it('caps the amount at the USDC debt', () => {
    const decision = expectRepay(decide(position({ usdcDebt: 1_500_000_000n })));
    expect(decision.amount).toBe(1_500_000_000n);
    expect(decision.limitedBy).toBe('debt');
  });

  it('takes the smallest of several caps', () => {
    const caps = { ...openCaps, maxPerRescue: 3_000_000_000n, rescuerBalance: 2_000_000_000n };
    const decision = expectRepay(decide(position({ caps })));
    expect(decision.amount).toBe(2_000_000_000n);
    expect(decision.limitedBy).toBe('rescuer_balance');
  });

  it('calls the target the limit when a cap only ties it', () => {
    const decision = expectRepay(decide(position({ caps: { ...openCaps, maxPerRescue: needed } })));
    expect(decision.limitedBy).toBe('target');
  });

  it.each([
    ['max_per_rescue_zero', { maxPerRescue: 0n }],
    ['budget_exhausted', { remainingToday: 0n }],
    ['rescuer_empty', { rescuerBalance: 0n }],
    ['no_allowance', { rescuerAllowance: 0n }],
  ])('reports %s as blocked rather than sending a zero amount', (reason, caps) => {
    const decision = decide(position({ caps: { ...openCaps, ...caps } }));
    expect(decision).toEqual({ action: 'none', reason, blocked: true });
  });

  it('still rescues what it can when capped, and projects the shortfall', () => {
    const caps = { ...openCaps, maxPerRescue: 2_000_000_000n };
    const decision = expectRepay(decide(position({ caps })));
    // 16,000 / 12,000
    expect(decision.projectedHealthFactor).toBe(1_333_333_333_333_333_333n);
    expect(decision.projectedHealthFactor).toBeLessThan(parseWad('1.6'));
  });
});

describe('decideManual: firing early', () => {
  it('acts above the trigger, because the keeper may fire early', () => {
    const decision = expectRepay(decideManual(position({ healthFactor: parseWad('5') }), 500_000n));
    expect(decision.amount).toBe(500_000n);
    expect(decision.limitedBy).toBe('target');
  });

  it('cannot exceed a cap', () => {
    const caps = { ...openCaps, maxPerRescue: 500_000n };
    const decision = expectRepay(decideManual(position({ caps }), 9_000_000n));
    expect(decision.amount).toBe(500_000n);
    expect(decision.limitedBy).toBe('max_per_rescue');
  });

  it('cannot run through a pause or a cooldown', () => {
    const paused = position({ caps: { ...openCaps, paused: true } });
    expect(decideManual(paused, 500_000n)).toMatchObject({ reason: 'paused' });
    const cooling = position({ caps: { ...openCaps, cooldownRemainingSecs: 30 } });
    expect(decideManual(cooling, 500_000n)).toMatchObject({ reason: 'cooldown' });
  });
});

describe('projectHealthFactor', () => {
  it('reports the no-debt sentinel when the repay clears the debt', () => {
    expect(projectHealthFactor(position(), 20_000n * 10n ** 6n)).toBe(MAX_UINT256);
  });

  it('lands on the target for an uncapped repay', () => {
    const decision = expectRepay(decide(position()));
    expect(decision.projectedHealthFactor).toBeGreaterThanOrEqual(parseWad('1.6'));
    expect(decision.projectedHealthFactor - parseWad('1.6')).toBeLessThan(10n ** 12n);
  });
});

describe('budget helpers', () => {
  const nowMs = Date.UTC(2026, 10, 9, 12, 0, 0);
  const today = BigInt(Math.floor(nowMs / 86_400_000));
  const budget = {
    maxPerDay: 1_000n,
    spentToday: 400n,
    day: today,
    cooldownSecs: 600,
    lastRescueAtNs: 0n,
  };

  it('subtracts what today has spent', () => {
    expect(remainingToday(budget, nowMs)).toBe(600n);
  });

  it('resets when the stored day is not today', () => {
    expect(remainingToday({ ...budget, day: today - 1n }, nowMs)).toBe(1_000n);
  });

  it('never goes below zero, even after caps were tightened below the spend', () => {
    expect(remainingToday({ ...budget, spentToday: 1_500n }, nowMs)).toBe(0n);
  });

  it('has no cooldown before the first rescue', () => {
    expect(cooldownRemainingSecs(budget, nowMs)).toBe(0);
  });

  it('counts the cooldown down from the last rescue', () => {
    const lastRescueAtNs = BigInt(nowMs - 100_000) * 1_000_000n;
    expect(cooldownRemainingSecs({ ...budget, lastRescueAtNs }, nowMs)).toBe(500);
  });

  it('reports zero once the cooldown has passed', () => {
    const lastRescueAtNs = BigInt(nowMs - 601_000) * 1_000_000n;
    expect(cooldownRemainingSecs({ ...budget, lastRescueAtNs }, nowMs)).toBe(0);
  });

  it('keeps the full cooldown when the contract clock is ahead of ours', () => {
    const lastRescueAtNs = BigInt(nowMs + 5_000) * 1_000_000n;
    expect(cooldownRemainingSecs({ ...budget, lastRescueAtNs }, nowMs)).toBe(600);
  });
});

describe('wad helpers', () => {
  it('parses decimals', () => {
    expect(parseWad('1.25')).toBe(1_250_000_000_000_000_000n);
    expect(parseWad('2')).toBe(2n * WAD);
    expect(parseWad('0.000000000000000001')).toBe(1n);
  });

  it.each(['', 'abc', '1.', '-1', '1e18', '1.0000000000000000001'])('rejects %j', (value) => {
    expect(() => parseWad(value)).toThrow();
  });

  it('formats the way the evidence format shows it', () => {
    expect(formatWad(parseWad('1.19'))).toBe('1.19');
    expect(formatWad(parseWad('1.5'))).toBe('1.5');
    expect(formatWad(2n * WAD)).toBe('2');
    expect(formatWad(1_234_567_890_000_000_000n)).toBe('1.234567');
  });

  it('truncates instead of rounding a health factor up', () => {
    expect(formatWad(999_999_999_999_999_999n)).toBe('0.999999');
  });

  it('labels the no-debt sentinel', () => {
    expect(formatWad(MAX_UINT256)).toBe('no_debt');
  });
});
