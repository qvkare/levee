/**
 * Collateral mode, spec section 9: R = (T × D − C × L) / (T − L_c × (1 + s)).
 * Every expected number below is worked by hand in the comment above it.
 */
import { describe, expect, it } from 'vitest';
import {
  type Caps,
  type CollateralTerms,
  type DecisionInput,
  FEE_UNIT,
  MAX_UINT256,
  REPAY_ROUNDING_UNITS,
  collateralForUsdc,
  decide,
  decideManual,
  parseWad,
  projectCollateralHealthFactor,
  repayFromCollateralToTarget,
  saleCostPpm,
  usdcCoveredByCollateral,
} from '../src/decision.js';

const openCaps: Caps = {
  maxPerRescue: 1_000_000n * 10n ** 6n,
  remainingToday: 1_000_000n * 10n ** 6n,
  // Collateral mode does not use the rescuer's USDC, so an empty rescuer must not matter.
  rescuerBalance: 0n,
  rescuerAllowance: 0n,
  cooldownRemainingSecs: 0,
  paused: false,
};

/** 10 WETH at $2,000, the only collateral, all of it approved. 0.05% pool, 1% slippage. */
const terms: CollateralTerms = {
  priceBase: 2_000n * 10n ** 8n,
  decimals: 18n,
  liquidationThresholdBps: 8_000n,
  aTokenBalance: 10n * 10n ** 18n,
  aTokenAllowance: 10n * 10n ** 18n,
  poolFee: 500n,
  maxSlippageBps: 100n,
};

type CollateralInput = DecisionInput & { collateral: CollateralTerms };

/** $20,000 of collateral at 80% against $14,000 of debt: health factor 1.142857. */
const position = (over: Partial<CollateralInput> = {}): CollateralInput => ({
  healthFactor: 1_142_857_142_857_142_857n,
  collateralBase: 20_000n * 10n ** 8n,
  debtBase: 14_000n * 10n ** 8n,
  liquidationThresholdBps: 8_000n,
  usdcPriceBase: 10n ** 8n,
  usdcDebt: 14_000n * 10n ** 6n,
  trigger: parseWad('1.25'),
  target: parseWad('1.6'),
  caps: openCaps,
  collateral: terms,
  ...over,
});

const withTerms = (over: Partial<CollateralTerms>) => position({ collateral: { ...terms, ...over } });

const repay = (decision: ReturnType<typeof decide>) => {
  if (decision.action !== 'repay') throw new Error(`expected a repay, got ${decision.reason}`);
  return decision;
};

/**
 * s = 500 / 1,000,000 + 100 / 10,000 = 0.0005 + 0.01 = 0.0105.
 * T × D − C × L = 1.6 × 14,000 − 20,000 × 0.8 = 22,400 − 16,000 = 6,400.
 * T − L_c × (1 + s) = 1.6 − 0.8 × 1.0105 = 1.6 − 0.8084 = 0.7916.
 * R = 6,400 / 0.7916 = $8,084.891359272...
 * In 8-decimal base units 808,489,135,927.236, rounded up to 808,489,135,928.
 * At $1.00000000 that is 8,084,891,359.28 USDC units, rounded up to 8,084,891,360,
 * plus 2 for Aave's rounding: 8,084,891,362.
 */
const NEEDED = 8_084_891_362n;

describe('the sale cost s', () => {
  it('is the pool fee plus the slippage limit, in hundredths of a basis point', () => {
    expect(saleCostPpm(terms)).toBe(10_500n);
    expect(saleCostPpm({ poolFee: 3_000n, maxSlippageBps: 300n })).toBe(33_000n);
    expect(FEE_UNIT).toBe(1_000_000n);
  });
});

describe('repayFromCollateralToTarget', () => {
  it('solves the section 9 formula', () => {
    expect(repayFromCollateralToTarget(position())).toBe(NEEDED);
  });

  it('applies the section 5 rounding: base up, USDC up, then two units', () => {
    // Without the two units: 8,084,891,360, which is the base amount rounded up twice.
    expect(repayFromCollateralToTarget(position())! - REPAY_ROUNDING_UNITS).toBe(8_084_891_360n);
  });

  it('asks for more than reserve mode, which sells nothing', () => {
    // Reserve mode: R = 14,000 − 16,000 / 1.6 = $4,000, or 4,000,000,002 units.
    expect(NEEDED).toBeGreaterThan(4_000_000_002n);
  });

  it('prices USDC from the oracle rather than assuming a dollar', () => {
    // 808,489,135,928 base units at $0.9998 each: 8,086,508,661.0 rounds up to
    // 8,086,508,662, plus 2.
    expect(repayFromCollateralToTarget(position({ usdcPriceBase: 99_980_000n }))).toBe(
      8_086_508_664n,
    );
  });

  it('asks for more when the sale may cost more', () => {
    // s = 0.003 + 0.03 = 0.033. 1.6 − 0.8 × 1.033 = 0.7736. 6,400 / 0.7736 = 8,273.0093...
    // Base 827,300,930,713.54 rounds up to ...714. USDC 8,273,009,307.14 rounds up to
    // 8,273,009,308, plus 2.
    expect(repayFromCollateralToTarget(withTerms({ poolFee: 3_000n, maxSlippageBps: 300n }))).toBe(
      8_273_009_310n,
    );
  });

  it('uses the sold collateral’s own threshold, not the average', () => {
    // L_c = 0.7: 1.6 − 0.7 × 1.0105 = 0.89265. 6,400 / 0.89265 = 7,169.6633...
    // Base 716,966,336,189.99 rounds up to ...190. USDC 7,169,663,361.9 rounds up to
    // 7,169,663,362, plus 2.
    expect(repayFromCollateralToTarget(withTerms({ liquidationThresholdBps: 7_000n }))).toBe(
      7_169_663_364n,
    );
  });

  it('returns zero when the position already meets the target', () => {
    expect(repayFromCollateralToTarget(position({ debtBase: 10_000n * 10n ** 8n }))).toBe(0n);
  });

  it('returns null when no sale can reach the target', () => {
    // L_c × (1 + s) = 1.6 × 1.0105 ≥ 1.6, so each dollar sold frees no capacity.
    expect(repayFromCollateralToTarget(withTerms({ liquidationThresholdBps: 16_000n }))).toBeNull();
  });
});

describe('projectCollateralHealthFactor', () => {
  const input = { ...position(), collateral: terms };

  it('lands on the target at the worst price for the uncapped amount', () => {
    const projected = projectCollateralHealthFactor(input, NEEDED);
    expect(projected).toBeGreaterThanOrEqual(parseWad('1.6'));
    expect(projected - parseWad('1.6')).toBeLessThan(10n ** 12n);
  });

  it('works a capped amount by hand', () => {
    // $5,000 repaid, $5,052.50 of WETH sold. 16,000 − 5,052.5 × 0.8 = 11,958 of capacity
    // against $9,000 of debt: 1.328666...
    expect(projectCollateralHealthFactor(input, 5_000n * 10n ** 6n)).toBe(1_328_666_666_666_666_666n);
  });

  it('reports the no-debt sentinel when the repay clears the debt', () => {
    expect(projectCollateralHealthFactor(input, 14_000n * 10n ** 6n)).toBe(MAX_UINT256);
  });

  it('reports zero rather than a negative health factor', () => {
    const thin = { ...input, collateral: { ...terms, liquidationThresholdBps: 16_000n } };
    expect(projectCollateralHealthFactor(thin, 13_000n * 10n ** 6n)).toBe(0n);
  });
});

describe('the collateral a repay implies', () => {
  it('converts collateral to the USDC it can pay for, rounding down', () => {
    // 10 WETH × $2,000 = $20,000, divided by 1.0105: $19,792.182088... so 19,792,182,088
    // USDC units.
    expect(usdcCoveredByCollateral(10n * 10n ** 18n, terms, 10n ** 8n)).toBe(19_792_182_088n);
  });

  it('converts USDC to the collateral it costs, rounding up', () => {
    // $5,000 × 1.0105 / $2,000 = 2.52625 WETH.
    expect(collateralForUsdc(5_000n * 10n ** 6n, terms, 10n ** 8n)).toBe(2_526_250_000_000_000_000n);
  });

  it('never covers more than the collateral it was given', () => {
    const covered = usdcCoveredByCollateral(10n * 10n ** 18n, terms, 10n ** 8n);
    expect(collateralForUsdc(covered, terms, 10n ** 8n)).toBeLessThanOrEqual(10n * 10n ** 18n);
    expect(collateralForUsdc(covered + 1n, terms, 10n ** 8n)).toBeGreaterThan(10n * 10n ** 18n);
  });

  it('respects the collateral’s decimals', () => {
    // 1 WBTC (8 decimals) at $60,000 covers $60,000 / 1.0105 = $59,376.5462...
    const wbtc = { ...terms, decimals: 8n, priceBase: 60_000n * 10n ** 8n };
    expect(usdcCoveredByCollateral(10n ** 8n, wbtc, 10n ** 8n)).toBe(59_376_546_264n);
  });
});

describe('decide in collateral mode', () => {
  it('repays what the target needs when nothing caps it', () => {
    const decision = repay(decide(position()));
    expect(decision).toMatchObject({ amount: NEEDED, needed: NEEDED, limitedBy: 'target' });
  });

  it('ignores the rescuer’s empty USDC balance and allowance', () => {
    // openCaps gives the rescuer nothing. Reserve mode would stop at rescuer_empty.
    expect(decide(position()).action).toBe('repay');
    const reserve: DecisionInput = { ...position() };
    delete reserve.collateral;
    expect(decide(reserve)).toMatchObject({ reason: 'rescuer_empty' });
  });

  it('caps at the position caps and the USDC debt', () => {
    const capped = position({ caps: { ...openCaps, maxPerRescue: 5_000n * 10n ** 6n } });
    expect(repay(decide(capped))).toMatchObject({ amount: 5_000n * 10n ** 6n, limitedBy: 'max_per_rescue' });
    const today = position({ caps: { ...openCaps, remainingToday: 3_000n * 10n ** 6n } });
    expect(repay(decide(today)).limitedBy).toBe('max_per_day');
    const debt = position({ usdcDebt: 6_000n * 10n ** 6n });
    expect(repay(decide(debt))).toMatchObject({ amount: 6_000n * 10n ** 6n, limitedBy: 'debt' });
  });

  it('caps at the collateral the borrower holds', () => {
    // 4 WETH covers $8,000 / 1.0105 = $7,916.8728..., under the $8,084.89 needed.
    const decision = repay(decide(withTerms({ aTokenBalance: 4n * 10n ** 18n })));
    expect(decision).toMatchObject({ amount: 7_916_872_835n, limitedBy: 'collateral_balance' });
  });

  it('caps at the allowance to the helper', () => {
    // 1 WETH covers $2,000 / 1.0105 = $1,979.2182...
    const decision = repay(decide(withTerms({ aTokenAllowance: 10n ** 18n })));
    expect(decision).toMatchObject({ amount: 1_979_218_208n, limitedBy: 'collateral_allowance' });
  });

  it('stops when the borrower holds no collateral', () => {
    expect(decide(withTerms({ aTokenBalance: 0n }))).toEqual({
      action: 'none',
      reason: 'no_collateral',
      blocked: true,
    });
  });

  it('stops when nothing is approved to the helper', () => {
    expect(decide(withTerms({ aTokenAllowance: 0n }))).toMatchObject({
      reason: 'no_collateral_allowance',
      blocked: true,
    });
  });

  it('stops when no sale can reach the target', () => {
    expect(decide(withTerms({ liquidationThresholdBps: 16_000n }))).toMatchObject({
      reason: 'target_unreachable',
      blocked: true,
    });
  });

  it('refuses to divide by a zero collateral price', () => {
    expect(decide(withTerms({ priceBase: 0n }))).toMatchObject({
      reason: 'oracle_price_zero',
      blocked: true,
    });
  });

  it('projects the health factor at the worst price', () => {
    const capped = position({ caps: { ...openCaps, maxPerRescue: 5_000n * 10n ** 6n } });
    expect(repay(decide(capped)).projectedHealthFactor).toBe(1_328_666_666_666_666_666n);
  });

  it('still respects pause, cooldown and the trigger', () => {
    expect(decide(position({ caps: { ...openCaps, paused: true } }))).toMatchObject({
      reason: 'paused',
    });
    expect(decide(position({ caps: { ...openCaps, cooldownRemainingSecs: 5 } }))).toMatchObject({
      reason: 'cooldown',
    });
    expect(decide(position({ healthFactor: parseWad('1.25') }))).toMatchObject({ reason: 'healthy' });
  });

  it('fires early by hand, within the collateral caps', () => {
    const early = position({ healthFactor: parseWad('2') });
    expect(repay(decideManual(early, 1_000_000n)).amount).toBe(1_000_000n);
    const tooMuch = withTerms({ aTokenAllowance: 10n ** 18n });
    expect(repay(decideManual(tooMuch, 9_000n * 10n ** 6n)).limitedBy).toBe('collateral_allowance');
  });
});
