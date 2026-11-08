import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { simulateUnwind, unwindToTarget, type CollateralPath, type Execution, type Executor, type UnwindParams } from '../src/sim/unwind.ts';

// The hand-worked collateral rescue. The position holds 4 WETH with a threshold of 0.80 and owes
// $6,000 of USDC. Capacity is units × price × threshold.
//
//    t  block  WETH price  capacity  debt  real HF
//    0      1      3,000     9,600   6000   1.60    armed here
//  100      2    2,437.5     7,800   6000   1.30
//  130      3      2,250     7,200   6000   1.20    below a 1.25 trigger
//  200      4   1,968.75     6,300   6000   1.05
//  240      5      1,800     5,760   6000   0.96    below 1, no liquidator yet
//  250      6      1,800     5,760   6000   0.96    real liquidation; frozen portfolio from here
//  310      7    1,687.5     5,400   6000   0.90
//  400      8      1,875     6,000   6000   1.00
const rows: Array<[t: number, block: number, price: number]> = [
  [0, 1, 3000],
  [100, 2, 2437.5],
  [130, 3, 2250],
  [200, 4, 1968.75],
  [240, 5, 1800],
  [250, 6, 1800],
  [310, 7, 1687.5],
  [400, 8, 1875],
];

function pathOf(points: Array<[number, number, number]>, options: { units?: number; liquidation?: { block: number; t: number } | null; debt?: number; usdcDebt?: number } = {}): CollateralPath {
  const units = options.units ?? 4;
  const n = points.length;
  const column = (f: (p: [number, number, number]) => number): Float64Array => Float64Array.from(points, f);
  return {
    n,
    t: column((p) => p[0]),
    block: column((p) => p[1]),
    capacity: column((p) => units * p[2] * 0.8),
    debt: column(() => options.debt ?? 6000),
    usdcDebt: column(() => options.usdcDebt ?? options.debt ?? 6000),
    price: column((p) => p[2]),
    units: column(() => units),
    lt: column(() => 0.8),
    liquidation: options.liquidation === undefined ? { block: 6, t: 250 } : options.liquidation,
  };
}

const params: UnwindParams = { trigger: 1.25, target: 1.5, delaySec: 60, cooldownSec: 30, slippageBps: 100, sizingFee: 0.0005, minUnwindUsd: 1 };

/** The oracle at a landing time is the last row at or before it. Each landing pays `costBps` over the oracle, unless that is over the cap. */
function executor(points: Array<[number, number, number]>, costBps: Record<number, number>, gasUsd = 0.1): Executor {
  return (request) => {
    const price = [...points].reverse().find((p) => p[0] <= request.landsAt)![2];
    const cost = costBps[request.landsAt] ?? 0;
    const base: Execution = { status: 'cap', block: request.landsAt, fee: 0, units: 0, paidUsd: 0, receivedUsd: 0, gapUsd: 0, gasUsd };
    if (cost > params.slippageBps) return base;
    const units = (request.amount / price) * (1 + cost / 1e4);
    return { ...base, status: 'landed', fee: 500, units, paidUsd: units * price, receivedUsd: request.amount };
  };
}

const close = (actual: number | undefined, expected: number, tolerance = 1e-6): void =>
  assert.ok(actual !== undefined && Math.abs(actual - expected) < tolerance, `${actual} is not ${expected}`);

describe('the collateral repay formula', () => {
  it('matches the spec: R = (G × D − CL) / (G − L_c × (1 + s))', () => {
    // CL 7,200, D 6,000, G 1.5, L_c 0.8, s 1.05%: 1,800 / (1.5 − 0.8084) = 2,602.6605.
    close(unwindToTarget(7200, 6000, 1.5, 0.8, 0.0105), 2602.6604973973394, 1e-9);
  });
  it('reaches the target exactly when the swap costs s', () => {
    const r = unwindToTarget(7200, 6000, 1.5, 0.8, 0.0105);
    close((7200 - r * 1.0105 * 0.8) / (6000 - r), 1.5, 1e-12);
  });
  it('is the reserve formula when the sold asset adds no capacity', () => {
    close(unwindToTarget(7200, 6000, 1.5, 0, 0.0105), 6000 - 7200 / 1.5, 1e-9);
  });
});

describe('hand-worked collateral rescue', () => {
  // s = 0.05% fee + 1% cap = 1.05%.
  // t=130: HF 1.20 < 1.25. R1 = (1.5 × 6000 − 7200) / (1.5 − 0.8 × 1.0105) = 2,602.6605. Lands at 190.
  //        It pays 30 bps over the oracle of 2,250: 2,602.6605 / 2,250 × 1.003 = 1.1602082 WETH, $7.81 over the oracle.
  // t=200: debt 3,397.3395. Capacity 6,300 − 1.1602082 × 1,968.75 × 0.8 = 4,472.6721. HF 1.3165. Above T.
  //        The WETH sold keeps falling in value after the sale: capacity is reduced at the price now.
  // t=240: capacity 5,760 − 1.1602082 × 1,800 × 0.8 = 4,089.3002. HF 1.2037 < 1.25.
  //        R2 = (1.5 × 3,397.3395 − 4,089.3002) / 0.6916 = 1,455.6233. Lands at 300, 50 bps over the oracle of 1,800:
  //        0.8127230 WETH, $7.28 over the oracle.
  // t=250: the real liquidator arrives. HF is 1.2037, so there is nothing to liquidate.
  // t=310: debt 1,941.7162. Capacity 5,400 − 1.9729312 × 1,687.5 × 0.8 = 2,736.5428. HF 1.4093.
  // t=400: capacity 6,000 − 1.9729312 × 1,875 × 0.8 = 3,040.6032. HF 1.5659.
  const outcome = simulateUnwind(pathOf(rows), params, executor(rows, { 190: 30, 300: 50 }));

  it('saves the position', () => {
    assert.equal(outcome.saved, true);
    assert.equal(outcome.reason, 'saved');
    assert.equal(outcome.armedBelowTrigger, false);
    assert.equal(outcome.firstDetection, 130);
  });
  it('sizes the first unwind with the collateral formula and lands it 60 s later', () => {
    const first = outcome.attempts[0]!;
    assert.equal(first.detectedAt, 130);
    assert.equal(first.landsAt, 190);
    close(first.amount, 2602.6604973973394);
    close(first.execution?.units, 1.1602082128397917);
    close(first.execution!.paidUsd - first.execution!.receivedUsd, 7.807981492192084);
  });
  it('does not fire at t=200, where the sold collateral is valued at the later price', () => {
    assert.equal(outcome.attempts[1]?.detectedAt, 240);
  });
  it('sizes the follow-up on the net position', () => {
    const second = outcome.attempts[1]!;
    assert.equal(second.landsAt, 300);
    close(second.amount, 1455.6233088393444);
    close(second.execution?.units, 0.8127230141019672);
  });
  it('adds up what was repaid, sold and paid', () => {
    assert.equal(outcome.sent, 2);
    assert.equal(outcome.landed, 2);
    assert.equal(outcome.reverted, 0);
    close(outcome.repaidUsd, 2602.6604973973394 + 1455.6233088393444);
    close(outcome.soldUnits, 1.1602082128397917 + 0.8127230141019672);
    close(outcome.swapCostUsd, 7.807981492192084 + 7.278116544196564);
    close(outcome.gasUsd, 0.2);
  });
});

describe('reverts and misses', () => {
  it('reverts an unwind over the cap, pays its gas, and tries again after the cooldown', () => {
    // The second unwind would cost 150 bps against a 100 bps cap. At t=310 HF is
    // (5,400 − 1.1602082 × 1,687.5 × 0.8) / 3,397.3395 = 1.1284, so the keeper fires again, landing at 370.
    const outcome = simulateUnwind(pathOf(rows), params, executor(rows, { 190: 30, 300: 150 }));
    assert.equal(outcome.saved, true);
    assert.deepEqual(
      outcome.attempts.map((a) => [a.landsAt, a.execution?.status]),
      [
        [190, 'landed'],
        [300, 'cap'],
        [370, 'landed'],
      ],
    );
    assert.equal(outcome.reverted, 1);
    close(outcome.gasUsd, 0.3);
  });
  it('calls a position that fails after a reverted unwind slippage_cap', () => {
    // As above, but WETH falls to 1,400 at t=310: HF (4,480 − 1.1602082 × 1,400 × 0.8) / 3,397.3395 = 0.936.
    const crash = rows.map((r): [number, number, number] => (r[0] === 310 ? [310, 7, 1400] : r));
    const outcome = simulateUnwind(pathOf(crash), params, executor(crash, { 190: 30, 300: 150 }));
    assert.equal(outcome.saved, false);
    assert.equal(outcome.reason, 'slippage_cap');
  });
  it('is too_slow when nothing lands before the liquidation', () => {
    const outcome = simulateUnwind(pathOf(rows), { ...params, delaySec: 200 }, executor(rows, {}));
    assert.equal(outcome.reason, 'too_slow');
    assert.equal(outcome.unresolved, 1);
    assert.equal(outcome.gasUsd, 0);
  });
  it('is under_minimum when every unwind the rule asks for is under $1', () => {
    // A dust position: $6 of debt and 0.004 WETH. At t=130 the rule asks for R of about $2.60, but only
    // 50 cents of it is USDC debt.
    const dust = rows.map((r): [number, number, number] => r);
    const path = pathOf(dust, { units: 0.004, debt: 6, usdcDebt: 0.5 });
    const outcome = simulateUnwind(path, params, executor(dust, {}));
    assert.equal(outcome.sent, 0);
    assert.equal(outcome.reason, 'under_minimum');
  });
  it('is no_warning when HF never crosses T before the liquidation', () => {
    const outcome = simulateUnwind(pathOf(rows), { ...params, trigger: 0.9 }, executor(rows, {}));
    assert.equal(outcome.reason, 'no_warning');
  });
  it('cuts an unwind to the collateral left and calls the miss collateral_exhausted', () => {
    // Only 0.3 of the 4 units are the sold asset; the rest of the capacity is other collateral. At t=130 the
    // unwind is cut to 0.3 × 2,250 / 1.0105 = $668.0, which is not enough, and nothing is left to sell after it.
    const path = pathOf(rows);
    path.units.fill(0.3);
    const outcome = simulateUnwind(path, params, executor(rows, {}));
    assert.equal(outcome.attempts[0]?.cutByCollateral, true);
    close(outcome.attempts[0]?.amount, (0.3 * 2250) / 1.0105);
    assert.equal(outcome.saved, false);
    assert.equal(outcome.reason, 'collateral_exhausted');
  });
});

describe('rules shared with the reserve mode', () => {
  it('does not send an unwind under the $1 floor', () => {
    // USDC debt of 50 cents: the cap makes every unwind smaller than $1.
    const outcome = simulateUnwind(pathOf(rows, { usdcDebt: 0.5, liquidation: null }), params, executor(rows, {}));
    assert.equal(outcome.sent, 0);
  });
  it('counts a landed repay only up to the USDC debt on the path', () => {
    // USDC debt is all repaid by the first unwind; later the borrower repays it itself (USDC debt 0 on the path).
    const path = pathOf(rows, { liquidation: null });
    path.usdcDebt.fill(0, 3);
    const outcome = simulateUnwind(path, params, executor(rows, {}));
    // From t=200 on, the repay counts for nothing, so HF is the path's minus the collateral sold: no second unwind fires,
    // because there is no USDC debt left to repay.
    assert.equal(outcome.sent, 1);
  });
  it('treats a member that was not liquidated as surviving, and still counts what it paid', () => {
    const outcome = simulateUnwind(pathOf(rows, { liquidation: null }), params, executor(rows, { 190: 30, 300: 50 }));
    assert.equal(outcome.saved, true);
    assert.equal(outcome.reason, null);
    assert.equal(outcome.landed, 2);
    assert.ok(outcome.swapCostUsd > 15);
  });
  it('arms below T and fires at once', () => {
    const below = rows.slice(2);
    const outcome = simulateUnwind(pathOf(below), params, executor(below, {}));
    assert.equal(outcome.armedBelowTrigger, true);
    assert.equal(outcome.attempts[0]?.detectedAt, 130);
  });
});
