import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DerivedPosition } from '../src/data.ts';
import { aggregate, exclusions, finalDescentGap, firstEpisodeBonus, paramsOf, population } from '../src/report/aggregate.ts';
import { classify } from '../src/scope.ts';
import type { Outcome, PositionPath } from '../src/sim/simulate.ts';

const USDC_ARB = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const USDCE_ARB = '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8';
const USDT_ARB = '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9';

describe('scope', () => {
  it('keeps a position whose debt is all native USDC', () => {
    assert.deepEqual(classify('arbitrum', [[USDC_ARB, '0', '1000000000', false]], 1000, 1), { scope: 'usdc_only', usdcShare: 1 });
  });

  it('does not treat USDC.e as USDC, even though the symbol matches', () => {
    assert.equal(classify('arbitrum', [[USDCE_ARB, '0', '1000000000', false]], 1000, 1).scope, 'no_usdc_debt');
  });

  it('marks a mixed position and reports its USDC share', () => {
    const result = classify(
      'arbitrum',
      [
        [USDC_ARB, '0', '600000000', false],
        [USDT_ARB, '0', '400000000', false],
      ],
      1000,
      1,
    );
    assert.equal(result.scope, 'usdc_mixed');
    assert.equal(result.usdcShare, 0.6);
  });

  it('treats a supply of USDC with no USDC debt as out of scope', () => {
    assert.equal(classify('arbitrum', [[USDC_ARB, '5000000000', '0', true]], 1000, 1).scope, 'no_usdc_debt');
  });

  it('calls a position USDC only at 99% and above', () => {
    assert.equal(classify('arbitrum', [[USDC_ARB, '0', '990000000', false]], 1000, 1).scope, 'usdc_only');
    assert.equal(classify('arbitrum', [[USDC_ARB, '0', '989000000', false]], 1000, 1).scope, 'usdc_mixed');
  });

  it('holds the share at 1 when oracle rounding pushes it over', () => {
    assert.equal(classify('arbitrum', [[USDC_ARB, '0', '1000000000', false]], 999, 1).usdcShare, 1);
  });

  it('uses the Base USDC address on Base', () => {
    assert.equal(classify('base', [[USDC_ARB, '0', '1000000000', false]], 1000, 1).scope, 'no_usdc_debt');
  });
});

const position = (over: Partial<DerivedPosition>): DerivedPosition => ({
  id: 'x',
  chain: 'base',
  window: 'w',
  user: '0x1',
  scope: 'usdc_only',
  usdcShare: 1,
  emode: 0,
  largestDebt: { symbol: 'USDC', asset: '0xusdc' },
  debtUsd: 100,
  collateralUsd: 200,
  liquidationBlock: 1,
  liquidationTime: 1000,
  events: [],
  ...over,
});
const event = (t: number, bonusUsd: number, debtUsd = 100): DerivedPosition['events'][number] => ({ block: t, t, tx: '0x', collateral: 'WETH', debt: 'USDC', debtUsd, bonusUsd });

describe('first episode bonus', () => {
  it('sums liquidations less than an hour apart', () => {
    assert.equal(firstEpisodeBonus(position({ events: [event(1000, 5), event(2000, 7), event(5000, 11)] })), 23);
  });

  it('stops at the first gap over an hour', () => {
    assert.equal(firstEpisodeBonus(position({ events: [event(1000, 5), event(5000, 7), event(5100, 11)] })), 5);
  });

  it('orders events by time first', () => {
    assert.equal(firstEpisodeBonus(position({ events: [event(9000, 7), event(1000, 5)] })), 5);
  });

  it('counts a gap of exactly an hour as the same episode', () => {
    assert.equal(firstEpisodeBonus(position({ events: [event(1000, 5), event(4600, 7)] })), 12);
  });
});

describe('final descent gap', () => {
  const path = (hfs: Array<[number, number]>): PositionPath => ({
    points: hfs.map(([t, hf], i) => ({ t, block: i + 1, capacity: hf * 100, debt: 100 })),
    liquidationBlock: hfs.length + 1,
    liquidationTime: 1000,
    usdcShare: 1,
  });

  it('measures from the first observation of the last descent', () => {
    const descent = path([
      [0, 1.3],
      [100, 1.1], // an earlier dip
      [200, 1.3], // recovered
      [700, 1.1], // final descent starts here
      [900, 0.99],
    ]);
    assert.equal(finalDescentGap(descent, 1.2), 300);
  });

  it('reports a position that stayed above T until the last observation', () => {
    assert.equal(finalDescentGap(path([[0, 1.3], [900, 1.25]]), 1.2), 'never_below');
  });

  it('reports a position below T at every observation', () => {
    assert.equal(finalDescentGap(path([[0, 1.1], [900, 1.05]]), 1.2), 'below_since_arming');
  });
});

describe('aggregate', () => {
  const outcome = (over: Partial<Outcome>): Outcome => ({
    saved: true,
    reason: 'saved',
    phase: null,
    reserve: 100,
    repaid: 40,
    landings: [],
    firstDetection: 0,
    armedBelowTrigger: false,
    minHfFromLiquidation: 1.2,
    ...over,
  });
  const item = (bonus: number) => ({ position: position({}), path: { points: [], liquidationBlock: 1, liquidationTime: 1, usdcShare: 1 }, firstEpisodeBonusUsd: bonus, allBonusUsd: bonus, usdcThreshold: 0.78 });
  const params = paramsOf({ trigger: 1.2, target: 1.5, reserveShare: 0.3, delaySec: 60 });

  const cell = aggregate(
    [
      { item: item(10), outcome: outcome({}) },
      { item: item(20), outcome: outcome({ armedBelowTrigger: true }) },
      { item: item(40), outcome: outcome({ saved: false, reason: 'too_slow', phase: 'at_real_liquidation', repaid: 0 }) },
      { item: item(80), outcome: outcome({ saved: false, reason: 'reserve_empty', phase: 'later_in_window', repaid: 100, armedBelowTrigger: true }) },
    ],
    params,
  );

  it('counts bonus avoided only on saved positions', () => {
    assert.equal(cell.bonusAvoidedUsd, 30);
    assert.equal(cell.bonusAtRiskUsd, 150);
  });

  it('splits saved and missed, and repays that fired at arming', () => {
    assert.equal(cell.saved, 2);
    assert.equal(cell.notSaved, 2);
    assert.equal(cell.armedBelowTrigger, 2);
    assert.equal(cell.savedArmedBelowTrigger, 1);
  });

  it('keeps reserve used on saved positions apart from misses', () => {
    assert.equal(cell.reserveUsedOnSavedUsd, 80);
    assert.equal(cell.reserveUsedOnMissesUsd, 100);
    assert.equal(cell.reserveHeldUsd, 400);
  });

  it('counts each reason and later failures', () => {
    assert.equal(cell.reasons.too_slow, 1);
    assert.equal(cell.reasons.reserve_empty, 1);
    assert.equal(cell.failedLaterInWindow, 1);
  });
});

describe('population and exclusions', () => {
  const rows = [
    position({ events: [event(1, 1, 100)] }),
    position({ scope: 'usdc_mixed', events: [event(1, 1, 100), event(2, 1, 100)] }),
    position({ scope: 'no_usdc_debt', chain: 'arbitrum', largestDebt: { symbol: 'USDC', asset: USDCE_ARB }, events: [event(1, 1, 50)] }),
    position({ scope: 'no_usdc_debt', chain: 'arbitrum', largestDebt: { symbol: 'USD₮0', asset: USDT_ARB }, events: [event(1, 1, 70)] }),
  ];

  it('labels bridged USDC by address, not by symbol', () => {
    const reasons = exclusions(rows).map((r) => r.reason);
    assert.ok(reasons.some((r) => r.startsWith('USDC.e')));
    assert.ok(reasons.includes('USD₮0 debt'));
    assert.ok(!reasons.includes('USDC debt'));
  });

  it('adds up to every position', () => {
    const table = population(rows);
    assert.equal(table.reduce((sum, r) => sum + r.positions, 0), 4);
    assert.equal(table.reduce((sum, r) => sum + r.inScope + r.excluded, 0), 4);
    assert.equal(table.reduce((sum, r) => sum + r.events, 0), 5);
  });
});
