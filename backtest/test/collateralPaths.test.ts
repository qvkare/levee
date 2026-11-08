import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chooseAsset, holdingsOf, memberPath, memberStart } from '../src/collateral/paths.ts';
import { deltaEncode, type WindowPrices } from '../src/data.ts';
import type { MarketSnapshot } from '../src/fetch/reserves.ts';
import { INDEX_UNIT, ReadCode, type PopulationFile } from '../src/portfolio/data.ts';
import { PeriodModel } from '../src/portfolio/model.ts';

const close = (actual: number | undefined, expected: number, digits = 1e-9): void => assert.ok(actual !== undefined && Math.abs(actual - expected) < digits, `${actual} is not ${expected}`);

const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const CBBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf';

// The fixture of population.test.ts, with a second collateral. Price rows at blocks 100 to 105:
//
//  block    t    WETH   USDC   cbBTC
//    100  1000  2000    1     100000
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
    { symbol: 'cbBTC', asset: CBBTC, at: deltaEncode([0]), price: deltaEncode([100000e8]) },
  ],
};

const market = {
  chain: 'base',
  window: 'test',
  block: 100,
  reserves: [
    { asset: WETH, symbol: 'WETH', decimals: 18, liquidationThreshold: 8000, liquidationBonus: 10500, id: 0 },
    { asset: USDC, symbol: 'USDC', decimals: 6, liquidationThreshold: 7800, liquidationBonus: 10450, id: 1 },
    { asset: CBBTC, symbol: 'cbBTC', decimals: 8, liquidationThreshold: 7500, liquidationBonus: 10500, id: 2 },
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

function file(reads: Read[], liquidations: PopulationFile['liquidations']): PopulationFile {
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
  const flat = deltaEncode([INDEX_UNIT, INDEX_UNIT]);
  return {
    chain: 'base',
    period: 'test',
    fromBlock: 100,
    toBlock: 105,
    fromTime: 1000,
    toTime: 1010,
    assets: [WETH, USDC, CBBTC],
    usdc: 1,
    census: { candidates: 2, startMembers: 1, newcomers: 1, totalSupply: '0', sumOfStartBalances: '0' },
    index: { t: deltaEncode([1000, 1010]), income: [flat, flat, flat], debt: [flat, deltaEncode([INDEX_UNIT, 1.01 * INDEX_UNIT]), flat] },
    usdcRates: { t: [], supplyApr: [], borrowApr: [] },
    members: ['0xa', '0xb'],
    liquidations,
    headline: [],
    reads: columns,
    balances,
  };
}

// Member 0 holds 0.8 WETH and 0.01 cbBTC ($1,600 and $1,000), owes 1,000 USDC, and repays half at block 103.
// Member 1 joins at block 102 in eMode 1 with 1 WETH and 1,200 USDC of debt, and is liquidated at block 104.
const reads: Read[] = [
  { member: 0, applyBlock: 100, applyT: 1000, code: ReadCode.Start, emode: 0, balances: [[0, 0.8, 0, 1], [1, 0, 1000, 0], [2, 0.01, 0, 1]] },
  { member: 0, applyBlock: 103, applyT: 1006, code: ReadCode.Partial, emode: 0, balances: [[1, 0, 500, 0]] },
  { member: 1, applyBlock: 102, applyT: 1004, code: ReadCode.Joined, emode: 1, balances: [[0, 1, 0, 1], [1, 0, 1200, 0]] },
  { member: 1, applyBlock: 103, applyT: 1006, code: ReadCode.BeforeLiquidation, emode: 1, balances: [[0, 1, 0, 1], [1, 0, 1200, 0]] },
];
const model = new PeriodModel(file(reads, [[1, 104, 1008, 50, 1]]), prices, market, false);

describe('which collateral is sold', () => {
  const start = memberStart(model, 0)!;
  const holdings = holdingsOf(model, start.arm, 100, 1000);
  it('values each collateral at the oracle at arming', () => {
    close(holdings.find((h) => h.asset === 0)?.valueUsd, 1600);
    close(holdings.find((h) => h.asset === 2)?.valueUsd, 1000);
  });
  it('takes the largest with a usable pool, else the next, else none', () => {
    assert.equal(chooseAsset(holdings, () => true), 0);
    assert.equal(chooseAsset(holdings, (a) => a === 2), 2);
    assert.equal(chooseAsset(holdings, () => false), null);
  });
  it('breaks a tie by the asset listed first', () => {
    assert.equal(chooseAsset([{ asset: 2, units: 1, valueUsd: 5 }, { asset: 0, units: 1, valueUsd: 5 }], () => true), 0);
  });
});

describe('collateral-mode path, every row', () => {
  const zero = memberPath(model, memberStart(model, 0)!, 0);
  it('has a point at every price row of its assets and every read, with no thinning', () => {
    assert.deepEqual([...zero.block], [100, 102, 103, 105]);
  });
  it('agrees with the rebuilt path where both have a point', () => {
    const built = model.build(0)!.path.points;
    for (let i = 0; i < zero.n; i++) {
      const p = built.find((q) => q.block === zero.block[i]);
      if (!p) continue;
      close(zero.capacity[i], p.capacity, 1e-6);
      close(zero.debt[i], p.debt, 1e-6);
    }
  });
  it('carries the sold asset: WETH price, 0.8 units, threshold 0.80', () => {
    assert.deepEqual([...zero.price], [2000, 1800, 1500, 1700]);
    for (let i = 0; i < zero.n; i++) {
      close(zero.units[i], 0.8);
      close(zero.lt[i], 0.8);
    }
  });
  it('freezes a liquidated member from the liquidation on, with its eMode threshold', () => {
    const one = memberPath(model, memberStart(model, 1)!, 0);
    // Arms at 102, read and row at 103, then the liquidation at 104 and the row at 105.
    assert.deepEqual([...one.block], [102, 103, 104, 105]);
    assert.deepEqual(one.liquidation, { block: 104, t: 1008 });
    close(one.lt[3], 0.9);
    // Frozen at block 104: 1 WETH × 1,500 × 0.9.
    close(one.capacity[2], 1350);
  });
});
