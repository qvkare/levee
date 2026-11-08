import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deltaEncode, type WindowPrices } from '../src/data.ts';
import type { Action } from '../src/fetch/actions.ts';
import type { BlockRange } from '../src/fetch/blocks.ts';
import { newcomers, planGrid } from '../src/fetch/portfolios.ts';
import type { MarketSnapshot } from '../src/fetch/reserves.ts';
import { INDEX_UNIT, ReadCode, type PopulationFile } from '../src/portfolio/data.ts';
import { PeriodModel } from '../src/portfolio/model.ts';

const close = (actual: number, expected: number, digits = 1e-9): void => assert.ok(Math.abs(actual - expected) < digits, `${actual} is not ${expected}`);

const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

// Price rows at blocks 100 to 105, two seconds apart. Only changes are stored.
//
//  block    t    WETH   USDC
//    100  1000  2000    1
//    102  1004  1800
//    103  1006  1500
//    105  1010  1700
const prices: WindowPrices = {
  chain: 'base',
  window: 'test',
  block: deltaEncode([100, 101, 102, 103, 104, 105]),
  t: deltaEncode([1000, 1002, 1004, 1006, 1008, 1010]),
  series: [
    { symbol: 'WETH', asset: WETH, at: deltaEncode([0, 2, 3, 5]), price: deltaEncode([2000e8, 1800e8, 1500e8, 1700e8]) },
    { symbol: 'USDC', asset: USDC, at: deltaEncode([0]), price: deltaEncode([1e8]) },
  ],
};

// WETH counts at 80%, or 90% in eMode 1. USDC debt grows 1% over the ten seconds, so interest shows.
const market = {
  chain: 'base',
  window: 'test',
  block: 100,
  reserves: [
    { asset: WETH, symbol: 'WETH', decimals: 18, liquidationThreshold: 8000, liquidationBonus: 10500, id: 0 },
    { asset: USDC, symbol: 'USDC', decimals: 6, liquidationThreshold: 7800, liquidationBonus: 10450, id: 1 },
  ],
  emodes: [{ id: 1, liquidationThreshold: 9000, liquidationBonus: 10200, collateralBitmap: '1' }],
} as unknown as MarketSnapshot;

interface Read {
  member: number;
  applyBlock: number;
  applyT: number;
  code: number;
  emode: number;
  balances: Array<[asset: number, supply: number, debt: number, collateral: number]>;
}

function file(reads: Read[], liquidations: PopulationFile['liquidations'] = []): PopulationFile {
  const columns: PopulationFile['reads'] = { member: [], applyBlock: [], applyT: [], readLag: [], readLagT: [], code: [], emode: [], hf: [], n: [] };
  const balances: PopulationFile['balances'] = { asset: [], supply: [], debt: [], collateral: [] };
  let lastMember = 0;
  let lastBlock = 0;
  let lastT = 0;
  for (const r of reads) {
    if (r.member !== lastMember) {
      lastBlock = 0;
      lastT = 0;
    }
    columns.member.push(r.member - lastMember);
    columns.applyBlock.push(r.applyBlock - lastBlock);
    columns.applyT.push(r.applyT - lastT);
    columns.readLag.push(0);
    columns.readLagT.push(0);
    columns.code.push(r.code);
    columns.emode.push(r.emode);
    columns.hf.push(-1);
    columns.n.push(r.balances.length);
    for (const [asset, supply, debt, collateral] of r.balances) {
      balances.asset.push(asset);
      balances.supply.push(supply);
      balances.debt.push(debt);
      balances.collateral.push(collateral);
    }
    lastMember = r.member;
    lastBlock = r.applyBlock;
    lastT = r.applyT;
  }
  return {
    chain: 'base',
    period: 'test',
    fromBlock: 100,
    toBlock: 105,
    fromTime: 1000,
    toTime: 1010,
    assets: [WETH, USDC],
    usdc: 1,
    census: { candidates: 2, startMembers: 1, newcomers: 1, totalSupply: '0', sumOfStartBalances: '0' },
    index: {
      t: deltaEncode([1000, 1010]),
      income: [deltaEncode([INDEX_UNIT, INDEX_UNIT]), deltaEncode([INDEX_UNIT, INDEX_UNIT])],
      debt: [deltaEncode([INDEX_UNIT, INDEX_UNIT]), deltaEncode([INDEX_UNIT, 1.01 * INDEX_UNIT])],
    },
    usdcRates: { t: [], supplyApr: [], borrowApr: [] },
    members: ['0xa', '0xb'],
    liquidations,
    headline: [],
    reads: columns,
    balances,
  };
}

// Member 0 holds 0.8 WETH and owes 1,000 USDC from the start, then repays half at block 103.
// Member 1 joins at block 102 in eMode 1 with 1 WETH and 1,200 USDC of debt, and is liquidated at block 104.
const reads: Read[] = [
  { member: 0, applyBlock: 100, applyT: 1000, code: ReadCode.Start, emode: 0, balances: [[0, 0.8, 0, 1], [1, 0, 1000, 0]] },
  { member: 0, applyBlock: 103, applyT: 1006, code: ReadCode.Partial, emode: 0, balances: [[1, 0, 500, 0]] },
  { member: 1, applyBlock: 102, applyT: 1004, code: ReadCode.Joined, emode: 1, balances: [[0, 1, 0, 1], [1, 0, 1200, 0]] },
  { member: 1, applyBlock: 103, applyT: 1006, code: ReadCode.BeforeLiquidation, emode: 1, balances: [[0, 1, 0, 1], [1, 0, 1200, 0]] },
];

describe('rebuilt member path, hand-worked', () => {
  for (const skip of [true, false]) {
    const model = new PeriodModel(file(reads, [[1, 104, 1008, 50, 1]]), prices, market, skip);

    describe(skip ? 'with the skip' : 'without the skip', () => {
      const zero = model.build(0)!;
      it('arms at the start: HF 0.8 × 2000 × 0.8 / 1000 = 1.28', () => {
        close(zero.armHf, 1.28);
        close(zero.armDebt, 1000);
      });
      it('grows debt with the interpolated index: at t 1004, HF 1152 / 1004', () => {
        const point = zero.path.points.find((p) => p.block === 102)!;
        close(point.capacity, 1152);
        close(point.debt, 1004);
      });
      it('applies a partial read and a price row in the same block as one point', () => {
        // Debt 500 × 1.006 at t 1006. WETH 1,500.
        const at103 = zero.path.points.filter((p) => p.block === 103);
        assert.equal(at103.length, 1);
        close(at103[0]!.capacity, 960);
        close(at103[0]!.debt, 503);
        close(at103[0]!.usdcDebt, 503);
      });
      it('keeps no more points once HF stays above the highest trigger, where the keeper never acts', () => {
        assert.equal(zero.path.points.find((p) => p.block === 105), undefined);
      });
      it('reports the exact lowest HF', () => {
        close(zero.minHf, 1152 / 1004);
      });

      const one = model.build(1)!;
      it('arms a newcomer at its first read, with its eMode threshold', () => {
        close(one.armHf, (1800 * 0.9) / (1200 * 1.004));
      });
      it('freezes a liquidated member from the liquidation on, at its state from the block before', () => {
        assert.deepEqual(one.path.liquidation, { block: 104, t: 1008 });
        const atLiquidation = one.path.points.find((p) => p.block === 104)!;
        close(atLiquidation.capacity, 1500 * 0.9);
        close(atLiquidation.debt, 1200 * 1.008);
        const after = one.path.points.find((p) => p.block === 105)!;
        close(after.capacity, 1700 * 0.9);
        close(after.debt, 1200 * 1.01);
        close(one.bonusUsd, 50);
      });
      it('measures the lowest HF up to the liquidation only', () => {
        close(one.minHf, (1500 * 0.9) / (1200 * 1.006));
      });
    });
  }

  it('gives the state in force at a block', () => {
    const model = new PeriodModel(file(reads), prices, market);
    close(model.hfAt(0, 102, 1004), 1152 / 1004);
    close(model.hfAt(0, 104, 1008), 960 / (500 * 1.008));
    assert.ok(Number.isNaN(model.hfAt(1, 101, 1002)));
  });

  it('leaves out an account never seen with USDC debt', () => {
    const noDebt: Read[] = [{ member: 0, applyBlock: 100, applyT: 1000, code: ReadCode.Start, emode: 0, balances: [[0, 1, 0, 1]] }];
    assert.equal(new PeriodModel(file(noDebt), prices, market).build(0), null);
  });
});

describe('re-read plan', () => {
  const range: BlockRange = { chain: 'base', window: 'test', fromBlock: 1000, toBlock: 1100, fromTimestamp: 0, toTimestamp: 200 };
  const action = (block: number, user: string, kind: Action['kind'], reserves: string[], logIndex = 0): Action => ({ block, t: block * 2, logIndex, user, reserves, kind });
  const actions: Action[] = [
    action(1000, '0xa', 'supply', [WETH]), // in the start read already
    action(1003, '0xa', 'borrow', [USDC]),
    action(1007, '0xa', 'repay', [USDC]),
    action(1012, '0xa', 'collateralOff', [WETH]),
    action(1005, '0xb', 'supply', [WETH]), // before 0xb borrows USDC: not tracked yet
    action(1006, '0xb', 'borrow', [USDC]),
    action(1009, '0xc', 'borrow', [WETH]), // never borrows USDC
  ];
  const start = new Set(['0xa']);
  const joined = newcomers(range, actions, start);
  const plan = planGrid(range, actions, start, joined, 10);

  it('finds newcomers by their first USDC borrow', () => {
    assert.deepEqual([...joined.keys()], ['0xb']);
    assert.equal(joined.get('0xb')!.block, 1006);
  });
  it('re-reads at the end of each interval, from the last action in it', () => {
    const first = plan.get(1010)!;
    const a = first.find((r) => r.user === '0xa')!;
    assert.equal(a.applyBlock, 1007);
    assert.deepEqual(a.reserves, [USDC]);
    assert.equal(a.full, false);
    const later = plan.get(1020)!.find((r) => r.user === '0xa')!;
    assert.equal(later.applyBlock, 1012);
    assert.deepEqual(later.reserves, [WETH]);
  });
  it('reads a newcomer in full the first time, and ignores what it did before joining', () => {
    const b = plan.get(1010)!.find((r) => r.user === '0xb')!;
    assert.equal(b.full, true);
    assert.equal(b.applyBlock, 1006);
    assert.deepEqual(b.reserves, [USDC]);
  });
  it('never reads an account that did not borrow USDC', () => {
    for (const reads of plan.values()) assert.ok(!reads.some((r) => r.user === '0xc'));
  });
});
