import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeObserved, deltaDecode, deltaEncode, encodeObserved, type CompactPoint, type WindowPrices } from '../src/data.ts';
import { PriceBook } from '../src/frozen.ts';

// Rows at blocks 100 to 104. Asset 0 is WETH, asset 1 is USDC.
//
//  block   t    WETH   USDC
//    100  1000  2000   1.00
//    101  1002  1900
//    102  1004         0.99
//    103  1006  1500
//    104  1008  1800
const prices: WindowPrices = {
  chain: 'base',
  window: 'test',
  block: deltaEncode([100, 101, 102, 103, 104]),
  t: deltaEncode([1000, 1002, 1004, 1006, 1008]),
  series: [
    { symbol: 'WETH', asset: '0xweth', at: deltaEncode([0, 1, 3, 4]), price: deltaEncode([2000e8, 1900e8, 1500e8, 1800e8]) },
    { symbol: 'USDC', asset: '0xusdc', at: deltaEncode([0, 2]), price: deltaEncode([1e8, 0.99e8]) },
  ],
};
const book = new PriceBook(prices);
// 1 WETH at LT 80%, 1,000 USDC of debt.
const portfolio = { collateral: [[0, 1, 8000]] as Array<[number, number, number]>, debt: [[1, 1000]] as Array<[number, number]> };

describe('delta columns', () => {
  it('round-trips', () => {
    assert.deepEqual(deltaDecode(deltaEncode([5, 7, 7, 3])), [5, 7, 7, 3]);
  });

  it('restores capacity and debt from HF and small units', () => {
    const points: CompactPoint[] = [
      [100, 1000, 1250, 1000],
      [101, 1002, 1200.5, 1000.25],
    ];
    const decoded = decodeObserved(encodeObserved(points));
    assert.ok(Math.abs(decoded[1]![3] - 1000.25) < 1e-6);
    assert.ok(Math.abs(decoded[1]![2] - 1200.5) < 0.06);
  });

  it('keeps HF exact on a dust position', () => {
    // Debt of 40 cents, HF 0.98. Cents alone could not carry this.
    const decoded = decodeObserved(encodeObserved([[100, 1000, 0.392, 0.4]]));
    assert.ok(Math.abs(decoded[0]![2] / decoded[0]![3] - 0.98) < 1e-9);
  });

  it('keeps six significant digits of a large debt', () => {
    const decoded = decodeObserved(encodeObserved([[100, 1000, 1_500_000, 1_234_567.89]]));
    assert.ok(Math.abs(decoded[0]![3] / 1_234_567.89 - 1) < 1e-5);
  });

  it('keeps a zero-debt observation at zero', () => {
    const decoded = decodeObserved(encodeObserved([[100, 1000, 0, 0]]));
    assert.deepEqual(decoded[0], [100, 1000, 0, 0]);
  });
});

describe('frozen path', () => {
  it('reads the step price in force at a block', () => {
    assert.deepEqual(book.pricesAt([0, 1], 102), [1900, 0.99]);
    assert.deepEqual(book.pricesAt([0, 1], 100), [2000, 1]);
  });

  it('marks the portfolio from the liquidation block on', () => {
    const path = book.frozenPath(portfolio, 101, 1002);
    const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;
    // Block 101: 1900 × 0.8 = 1,520 against 1,000.
    assert.equal(path[0]![0], 101);
    assert.ok(near(path[0]![2], 1520) && near(path[0]![3], 1000));
    // Block 103 is the low: 1500 × 0.8 = 1,200 against 990.
    assert.ok(path.some((p) => p[0] === 103 && near(p[2], 1200) && near(p[3], 990)));
    // The last block is kept: 1800 × 0.8 = 1,440.
    const last = path[path.length - 1]!;
    assert.equal(last[0], 104);
    assert.ok(near(last[2], 1440) && near(last[3], 990));
  });

  it('starts between rows at the price in force', () => {
    // No row at 101.5: the start block is treated as block 101's prices.
    const path = book.frozenPath(portfolio, 101, 1003);
    assert.equal(path[0]![1], 1003);
    assert.ok(Math.abs(path[0]![2] - 1520) < 1e-6);
  });

  it('sums every holding, each at its own threshold', () => {
    const mixed = { collateral: [[0, 1, 8000], [1, 500, 7800]] as Array<[number, number, number]>, debt: [[1, 1000]] as Array<[number, number]> };
    // 2000 × 0.8 + 500 × 1 × 0.78 = 1,990.
    assert.ok(Math.abs(book.frozenPath(mixed, 100, 1000)[0]![2] - 1990) < 1e-6);
  });

  it('refuses an asset with no price yet', () => {
    const late: WindowPrices = { ...prices, series: [{ symbol: 'X', asset: '0xx', at: deltaEncode([3]), price: deltaEncode([1e8]) }] };
    assert.throws(() => new PriceBook(late).pricesAt([0], 100), /no price/);
  });
});
