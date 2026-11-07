import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { holdAsCollateral, repayAtArming } from '../src/sim/baselines.ts';
import { healthFactor, repayToTarget, simulate, type Params, type PathPoint, type PositionPath } from '../src/sim/simulate.ts';

// The hand-worked position. Debt is $6,000 of USDC. Capacity is collateral × threshold.
//
//    t  block  capacity  debt  real HF
//    0      1     9,600  6000   1.60    armed here
//  100      2     7,800  6000   1.30
//  130      3     7,200  6000   1.20    below a 1.25 trigger
//  200      4     6,300  6000   1.05
//  240      5     5,760  6000   0.96    below 1, no liquidator yet
//  250      6     5,760  6000   0.96    real liquidation; frozen portfolio from here
//  310      7     5,400  6000   0.90
//  400      8     6,000  6000   1.00
const points: PathPoint[] = [
  { t: 0, block: 1, capacity: 9600, debt: 6000 },
  { t: 100, block: 2, capacity: 7800, debt: 6000 },
  { t: 130, block: 3, capacity: 7200, debt: 6000 },
  { t: 200, block: 4, capacity: 6300, debt: 6000 },
  { t: 240, block: 5, capacity: 5760, debt: 6000 },
  { t: 250, block: 6, capacity: 5760, debt: 6000 },
  { t: 310, block: 7, capacity: 5400, debt: 6000 },
  { t: 400, block: 8, capacity: 6000, debt: 6000 },
];
const path: PositionPath = { points, liquidationBlock: 6, liquidationTime: 250, usdcShare: 1 };
const params: Params = { trigger: 1.25, target: 1.5, reserveShare: 0.3, delaySec: 60, cooldownSec: 30 };

const close = (actual: number, expected: number, digits = 1e-9): void =>
  assert.ok(Math.abs(actual - expected) < digits, `${actual} is not ${expected}`);

describe('formulas', () => {
  it('matches the spec repay formula: R = D - (C * L) / T', () => {
    // C = 10,000, L = 0.72, D = 6,000, target 1.5: 6000 - 7200 / 1.5 = 1,200.
    close(repayToTarget(10_000 * 0.72, 6000, 1.5), 1200);
  });
  it('floors a repay at zero when the position is already above target', () => {
    assert.equal(repayToTarget(9600, 6000, 1.5), 0);
  });
  it('treats zero debt as infinite health', () => {
    assert.equal(healthFactor(100, 0), Infinity);
  });
});

describe('hand-worked rescue', () => {
  // Reserve = 30% of 6,000 = 1,800.
  // t=130: HF 1.20 < 1.25. Need 6000 - 7200/1.5 = 1,200. Lands at t=190. 600 left.
  // t=200: debt 4,800, HF 6300/4800 = 1.3125. Above trigger.
  // t=240: HF 5760/4800 = 1.20. Need 4800 - 5760/1.5 = 960, capped to the 600 left. Lands at t=300.
  // t=250: the real liquidator arrives. HF is 1.20, so there is nothing to liquidate.
  // t=310: debt 4,200, HF 5400/4200 = 1.2857.
  // t=400: HF 6000/4200 = 1.4286.
  const outcome = simulate(path, params);

  it('saves the position', () => {
    assert.equal(outcome.saved, true);
    assert.equal(outcome.reason, 'saved');
    assert.equal(outcome.phase, null);
    assert.equal(outcome.armedBelowTrigger, false);
  });
  it('sizes the reserve on debt at arming', () => {
    close(outcome.reserve, 1800);
  });
  it('lands the first repay 60 s after detection, sized for the target', () => {
    assert.equal(outcome.firstDetection, 130);
    assert.equal(outcome.landings[0]?.landedAt, 190);
    close(outcome.landings[0]?.amount ?? 0, 1200);
  });
  it('fires a second repay capped by what is left', () => {
    assert.equal(outcome.landings[1]?.detectedAt, 240);
    assert.equal(outcome.landings[1]?.landedAt, 300);
    close(outcome.landings[1]?.amount ?? 0, 600);
    close(outcome.repaid, 1800);
  });
  it('reports the lowest HF from the real liquidation on', () => {
    close(outcome.minHfFromLiquidation, 1.2);
  });
});

describe('misses', () => {
  it('gives a tie with the liquidator to the liquidator', () => {
    // Detected at 130, lands at exactly 250, the block the liquidator took.
    const outcome = simulate(path, { ...params, delaySec: 120 });
    assert.equal(outcome.saved, false);
    assert.equal(outcome.reason, 'too_slow');
    assert.equal(outcome.phase, 'at_real_liquidation');
    assert.equal(outcome.repaid, 0);
  });

  it('wins by one second less', () => {
    assert.equal(simulate(path, { ...params, delaySec: 119 }).saved, true);
  });

  it('reports no_warning when HF never shows below trigger before the block', () => {
    const outcome = simulate(path, { ...params, trigger: 0.95 });
    assert.equal(outcome.reason, 'no_warning');
    assert.equal(outcome.firstDetection, null);
  });

  it('reports reserve_empty when the reserve is too small for the later drop', () => {
    // Reserve 300 lands at 190. At 250, HF is 5760/5700 = 1.0105, so the first
    // liquidation is beaten. At 310, HF is 5400/5700 = 0.947. The position still dies.
    const outcome = simulate(path, { ...params, reserveShare: 0.05 });
    assert.equal(outcome.saved, false);
    assert.equal(outcome.reason, 'reserve_empty');
    assert.equal(outcome.phase, 'later_in_window');
    close(outcome.minHfFromLiquidation, 5400 / 5700);
  });

  it('reports usdc_debt_exhausted when only part of the debt is USDC', () => {
    // USDC is 5% of debt, so 300 is repayable while the reserve still holds 1,500.
    const outcome = simulate({ ...path, usdcShare: 0.05 }, params);
    assert.equal(outcome.saved, false);
    assert.equal(outcome.reason, 'usdc_debt_exhausted');
    close(outcome.repaid, 300);
  });

  it('reports follow_up_too_slow when reserve remains but the next repay is in flight', () => {
    // First repay of 1,200 lands at 190. HF 1.05 at t=200 is below trigger. With a long
    // cooldown nothing else fires, and HF falls below 1 at the later drop.
    const steep: PositionPath = {
      ...path,
      points: [
        ...points.slice(0, 6),
        { t: 310, block: 7, capacity: 4000, debt: 6000 },
      ],
    };
    const outcome = simulate(steep, { ...params, cooldownSec: 10_000 });
    assert.equal(outcome.reason, 'follow_up_too_slow');
    assert.equal(outcome.phase, 'later_in_window');
  });
});

describe('keeper rules', () => {
  it('holds one repay in flight at a time', () => {
    // With D = 100, the t=200 observation is below trigger, but the first repay is still
    // in flight until 230, so only t=240 can fire the second.
    const outcome = simulate(path, { ...params, delaySec: 100, cooldownSec: 0 });
    assert.equal(outcome.landings[0]?.landedAt, 230);
    assert.equal(outcome.landings[1]?.detectedAt, 240);
  });

  it('respects the cooldown between repays', () => {
    const outcome = simulate(path, { ...params, cooldownSec: 150 });
    // 240 - 130 = 110 is inside the cooldown, so the second repay waits for t=310.
    assert.equal(outcome.landings[1]?.detectedAt, 310);
    assert.equal(outcome.saved, true);
  });

  it('flags a position armed below its trigger and fires at once', () => {
    const outcome = simulate(path, { ...params, trigger: 1.7, target: 2 });
    assert.equal(outcome.armedBelowTrigger, true);
    assert.equal(outcome.firstDetection, 0);
    assert.equal(outcome.landings[0]?.detectedAt, 0);
    // Need 6000 - 9600/2 = 1,200 at t=0.
    close(outcome.landings[0]?.amount ?? 0, 1200);
  });

  it('does not count a landing after the path ends as repaid', () => {
    const short: PositionPath = { ...path, points: points.slice(0, 6) };
    const outcome = simulate(short, { ...params, delaySec: 60 });
    // Second repay is detected at 240 and lands at 300, after the last point.
    assert.equal(outcome.landings.length, 1);
    close(outcome.repaid, 1200);
  });

  it('ignores points before debt exists', () => {
    const late: PositionPath = {
      ...path,
      points: [{ t: -50, block: 0, capacity: 100, debt: 0 }, ...points],
    };
    assert.deepEqual(simulate(late, params), simulate(path, params));
  });
});

describe('baselines', () => {
  it('values reserve held as collateral at its liquidation threshold', () => {
    // Reserve 1,800 at LT 0.78 adds 1,404. Worst point from t=250 on: (5400+1404)/6000 = 1.134.
    const outcome = holdAsCollateral(path, 0.3, 0.78);
    assert.equal(outcome.survived, true);
    close(outcome.minHfFromLiquidation, 6804 / 6000);
  });

  it('fails when the same dollars are too few as collateral', () => {
    // Reserve 300 adds 234. At t=310: 5634/6000 = 0.939.
    const outcome = holdAsCollateral(path, 0.05, 0.78);
    assert.equal(outcome.survived, false);
  });

  it('shows repaying is worth more per dollar than holding collateral', () => {
    // At the worst point, capacity 5,400 against debt 6,000 needs 600 of repay,
    // or 600 / 0.78 = 769.2 of USDC collateral. A reserve of 11% (660) separates them.
    assert.equal(repayAtArming(path, 0.11).survived, true);
    assert.equal(holdAsCollateral(path, 0.11, 0.78).survived, false);
  });

  it('caps a repay at the USDC share of debt', () => {
    assert.equal(repayAtArming({ ...path, usdcShare: 0.05 }, 0.3).survived, false);
  });
});
