import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { repayAtArming } from '../src/sim/baselines.ts';
import { simulate, type Params, type PathPoint, type PositionPath } from '../src/sim/simulate.ts';
import { simulateShared, simulateTracked, survivesUpfront, type TrackedPath, type TrackedPoint } from '../src/sim/tracked.ts';

const close = (actual: number, expected: number, digits = 1e-9): void => assert.ok(Math.abs(actual - expected) < digits, `${actual} is not ${expected}`);

const tracked = (path: PositionPath): TrackedPath => ({
  points: path.points.map((p) => ({ ...p, usdcDebt: path.usdcShare * p.debt })),
  liquidation: { block: path.liquidationBlock, t: path.liquidationTime },
});

// Position A is the hand-worked position from simulate.test.ts: $6,000 of USDC debt,
// liquidated in reality at block 6, t = 250.
const a: TrackedPath = {
  points: [
    { t: 0, block: 1, capacity: 9600, debt: 6000, usdcDebt: 6000 },
    { t: 100, block: 2, capacity: 7800, debt: 6000, usdcDebt: 6000 },
    { t: 130, block: 3, capacity: 7200, debt: 6000, usdcDebt: 6000 },
    { t: 200, block: 4, capacity: 6300, debt: 6000, usdcDebt: 6000 },
    { t: 240, block: 5, capacity: 5760, debt: 6000, usdcDebt: 6000 },
    { t: 250, block: 6, capacity: 5760, debt: 6000, usdcDebt: 6000 },
    { t: 310, block: 7, capacity: 5400, debt: 6000, usdcDebt: 6000 },
    { t: 400, block: 8, capacity: 6000, debt: 6000, usdcDebt: 6000 },
  ],
  liquidation: { block: 6, t: 250 },
};

// Position B, on the other chain: $4,000 of USDC debt, never liquidated in reality. It dips
// below the trigger at t = 60 and recovers on its own: a false alarm.
//
//    t  block  capacity  debt  real HF
//    0   1000     5,600  4000   1.40
//   60   1001     4,800  4000   1.20    below 1.25: asks for 4000 - 4800/1.5 = 800
//  120   1002     4,400  4000   1.10
//  180   1003     4,400  4000   1.10
//  300   1004     5,200  4000   1.30
const b: TrackedPath = {
  points: [
    { t: 0, block: 1000, capacity: 5600, debt: 4000, usdcDebt: 4000 },
    { t: 60, block: 1001, capacity: 4800, debt: 4000, usdcDebt: 4000 },
    { t: 120, block: 1002, capacity: 4400, debt: 4000, usdcDebt: 4000 },
    { t: 180, block: 1003, capacity: 4400, debt: 4000, usdcDebt: 4000 },
    { t: 300, block: 1004, capacity: 5200, debt: 4000, usdcDebt: 4000 },
  ],
  liquidation: null,
};

// Position B', the same debt, never below the trigger.
const calmB: TrackedPath = { points: b.points.map((p) => ({ ...p, capacity: 5600 })), liquidation: null };

const params: Params = { trigger: 1.25, target: 1.5, reserveShare: 0, delaySec: 60, cooldownSec: 30 };

describe('shared reserve, hand-worked', () => {
  describe('the partner false alarm takes the reserve first: R 12%, budget 0.12 × 10,000 = 1,200', () => {
    // t=60:  B asks for 800 and gets it. 400 left. Lands at 120.
    // t=130: A asks for 1,200 and gets the 400 left. Lands at 190. Nothing left.
    // t=200: A's debt is 5,600 and HF 6300/5600 = 1.125, below the trigger, but the reserve is empty.
    // t=250: the real liquidator arrives. HF 5760/5600 = 1.029, so A beats it.
    // t=310: HF 5400/5600 = 0.964. A is liquidated later in the window.
    const [outA, outB] = simulateShared([a, b], 1200, params);

    it('lets B draw 800 on a false alarm', () => {
      assert.equal(outB!.saved, true);
      assert.equal(outB!.reason, null);
      close(outB!.repaid, 800);
      assert.equal(outB!.landings[0]?.landedAt, 120);
    });
    it('leaves A only 400, and A is liquidated later in the window', () => {
      close(outA!.repaid, 400);
      assert.equal(outA!.landings[0]?.landedAt, 190);
      assert.equal(outA!.saved, false);
      assert.equal(outA!.reason, 'reserve_empty');
    });
    it('would have saved A with its own 12% reserve of 720', () => {
      // 720 lands at 190. At 310, HF 5400/5280 = 1.023.
      const own = simulateTracked(a, { ...params, reserveShare: 0.12 });
      assert.equal(own.saved, true);
      close(own.repaid, 720);
    });
    it('would have saved A with 720 repaid upfront', () => {
      assert.equal(survivesUpfront(a, 720), true);
    });
  });

  describe('the partner never draws: R 8%, budget 800', () => {
    // t=130: A asks for 1,200 and gets all 800. Lands at 190.
    // t=310: HF 5400/5200 = 1.038. A survives the window.
    const [outA, outB] = simulateShared([a, calmB], 800, params);

    it('gives A the whole budget, which saves it', () => {
      assert.equal(outA!.saved, true);
      assert.equal(outA!.reason, 'saved');
      close(outA!.repaid, 800);
      close(outB!.repaid, 0);
    });
    it('would not have saved A with its own 8% reserve of 480', () => {
      // 480 lands at 190. At 310, HF 5400/5520 = 0.978.
      const own = simulateTracked(a, { ...params, reserveShare: 0.08 });
      assert.equal(own.saved, false);
      assert.equal(own.reason, 'reserve_empty');
    });
    it('would not have saved A with 480 repaid upfront', () => {
      assert.equal(survivesUpfront(a, 480), false);
    });
  });

  it('runs a tie in the order the paths were given', () => {
    // Both at HF 1.0 at t = 0, each asking for 1000 - 1000/1.5 = 333, with a budget of 100.
    const flat = (block: number): TrackedPath => ({
      points: [
        { t: 0, block, capacity: 1000, debt: 1000, usdcDebt: 1000 },
        { t: 100, block: block + 1, capacity: 1000, debt: 1000, usdcDebt: 1000 },
      ],
      liquidation: null,
    });
    const [first, second] = simulateShared([flat(1), flat(9)], 100, params);
    close(first!.repaid, 100);
    close(second!.repaid, 0);
    const [secondFirst, firstSecond] = simulateShared([flat(9), flat(1)], 100, params);
    close(secondFirst!.repaid, 100);
    close(firstSecond!.repaid, 0);
  });
});

describe('tracked rule against simulate', () => {
  it('matches the hand-worked position at every reserve size', () => {
    const path: PositionPath = {
      points: a.points.map(({ t, block, capacity, debt }) => ({ t, block, capacity, debt })),
      liquidationBlock: 6,
      liquidationTime: 250,
      usdcShare: 1,
    };
    for (const reserveShare of [0.05, 0.08, 0.1, 0.12, 0.3]) {
      const p = { ...params, reserveShare };
      const expected = simulate(path, p);
      const actual = simulateTracked(tracked(path), p);
      assert.equal(actual.saved, expected.saved);
      assert.equal(actual.reason, expected.reason);
      close(actual.repaid, expected.repaid);
    }
  });

  it('matches simulate on 400 random paths and a spread of parameters', () => {
    // Mulberry32, so the paths are the same on every run.
    let seed = 7;
    const random = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
    let compared = 0;
    for (let n = 0; n < 400; n++) {
      const points: PathPoint[] = [];
      let capacity = 1.1 + random() * 0.6;
      let debt = 1;
      const length = 5 + Math.floor(random() * 40);
      let t = 0;
      for (let i = 0; i < length; i++) {
        t += 1 + Math.floor(random() * 120);
        capacity *= 1 + (random() - 0.55) * 0.08;
        if (random() < 0.1) debt *= 1 + (random() - 0.5) * 0.2;
        points.push({ t, block: i + 1, capacity: capacity * 1000, debt: debt * 1000 });
      }
      const liquidation = points[Math.floor(length / 2) + Math.floor(random() * (length / 2))]!;
      const path: PositionPath = { points, liquidationBlock: liquidation.block, liquidationTime: liquidation.t, usdcShare: random() < 0.3 ? 0.5 + random() * 0.5 : 1 };
      for (const trigger of [1.05, 1.2, 1.3]) {
        for (const reserveShare of [0.05, 0.3]) {
          for (const delaySec of [10, 60, 300]) {
            const p: Params = { trigger, target: 1.5, reserveShare, delaySec, cooldownSec: 60 };
            const expected = simulate(path, p);
            const actual = simulateTracked(tracked(path), p);
            const shared = simulateShared([tracked(path)], reserveShare * points[0]!.debt, p)[0]!;
            for (const out of [actual, shared]) {
              assert.equal(out.saved, expected.saved);
              assert.equal(out.reason, expected.reason);
              close(out.repaid, expected.repaid, 1e-6);
              assert.equal(out.firstDetection, expected.firstDetection);
              assert.equal(out.armedBelowTrigger, expected.armedBelowTrigger);
            }
            assert.equal(survivesUpfront(tracked(path), reserveShare * points[0]!.debt), repayAtArming(path, reserveShare).survived);
            compared++;
          }
        }
      }
    }
    assert.equal(compared, 400 * 18);
  });
});

describe('a member that was not liquidated', () => {
  const point = (t: number, capacity: number, debt: number, usdcDebt: number): TrackedPoint => ({ t, block: t, capacity, debt, usdcDebt });

  it('counts as saved whatever its path shows, and draws only what the rule asks', () => {
    // HF 1.10 at t=10: asks for 1000 - 1100/1.5 = 266.67. Lands at 70.
    const path: TrackedPath = { points: [point(0, 1300, 1000, 1000), point(10, 1100, 1000, 1000), point(100, 900, 1000, 1000)], liquidation: null };
    const out = simulateTracked(path, { ...params, reserveShare: 0.3 });
    assert.equal(out.saved, true);
    assert.equal(out.reason, null);
    close(out.repaid, 1000 - 1100 / 1.5);
  });

  it('caps a repay at the USDC debt on the path at that point', () => {
    // The member repaid most of its USDC on its own before HF fell: only 50 is left to repay.
    const path: TrackedPath = { points: [point(0, 1300, 1000, 1000), point(10, 1100, 1000, 50), point(100, 1100, 1000, 50)], liquidation: null };
    const out = simulateTracked(path, { ...params, reserveShare: 0.3 });
    close(out.repaid, 50);
  });
});

describe('a landed repay capped at the USDC debt on the path', () => {
  const point = (t: number, block: number, capacity: number, debt: number, usdcDebt: number): TrackedPoint => ({ t, block, capacity, debt, usdcDebt });
  // HF 1.10 at t=10: Levee sends 1000 - 1100/1.5 = 266.67, which lands at 70. By t=100 the
  // borrower has repaid all its USDC itself and owes 800 of another stablecoin. HF 760/800 = 0.95.
  // Liquidated in reality at block 3.
  const path: TrackedPath = {
    points: [point(0, 1, 1300, 1000, 1000), point(10, 2, 1100, 1000, 1000), point(100, 3, 760, 800, 0)],
    liquidation: { block: 3, t: 100 },
  };
  const p: Params = { trigger: 1.2, target: 1.5, reserveShare: 0.3, delaySec: 60, cooldownSec: 60 };

  it('is saved under the pre-registered rule, which keeps the repay off total debt', () => {
    // 800 - 266.67 = 533.33, HF 1.425.
    assert.equal(simulateTracked(path, p).saved, true);
  });
  it('is not saved when the repay counts only up to the USDC debt left, as upfront', () => {
    assert.equal(simulateTracked(path, p, { capLanded: true }).saved, false);
    assert.equal(survivesUpfront(path, 300), false);
  });
  it('never saves a position the same USDC repaid upfront would lose', () => {
    let seed = 11;
    const random = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
    let checked = 0;
    for (let n = 0; n < 300; n++) {
      const points: TrackedPoint[] = [];
      let capacity = 1.05 + random() * 0.5;
      let usdc = 0.4 + random() * 0.6;
      for (let i = 0; i < 30; i++) {
        capacity *= 1 + (random() - 0.55) * 0.08;
        if (random() < 0.1) usdc *= random();
        points.push(point(i * 30, i + 1, capacity * 1000, 1000, Math.min(usdc, 1) * 1000));
      }
      const liquidation = points[10 + Math.floor(random() * 19)]!;
      const tracked: TrackedPath = { points, liquidation: { block: liquidation.block, t: liquidation.t } };
      for (const reserveShare of [0.05, 0.2, 0.5]) {
        if (!simulateTracked(tracked, { ...p, reserveShare }, { capLanded: true }).saved) continue;
        assert.equal(survivesUpfront(tracked, reserveShare * 1000), true);
        checked++;
      }
    }
    assert.ok(checked > 50, `only ${checked} saved cases checked`);
  });
});
