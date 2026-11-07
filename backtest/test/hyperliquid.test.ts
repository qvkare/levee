import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { reduceCsv } from '../src/fetch/hyperliquid.ts';
import { bucketOf, inferredLeverage, liquidationDistance, summarizeHyperliquid, topUpNeeded } from '../src/hyperliquid.ts';

const close = (a: number, b: number): void => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);

describe('hyperliquid arithmetic', () => {
  it('finds the fall that reaches maintenance for a lone long', () => {
    // 10x, maintenance 1.25%. Equity 0.1, notional 1. 0.1 - d = 0.0125 (1 - d).
    close(liquidationDistance(10, 0.0125), 0.0875 / 0.9875);
  });

  it('needs no top-up for a fall short of liquidation', () => {
    assert.equal(topUpNeeded(5, 0.0125, 0.1), 0);
  });

  it('sizes the top-up in units of starting equity', () => {
    // 10x, fall 13%, maintenance 1.25%: 10 (0.13 + 0.0125 × 0.87) - 1 = 0.40875.
    close(topUpNeeded(10, 0.0125, 0.13), 0.40875);
  });

  it('agrees with itself: the liquidation distance needs exactly zero top-up', () => {
    close(topUpNeeded(10, 0.0125, liquidationDistance(10, 0.0125)), 0);
  });

  it('inverts the distance back to leverage', () => {
    const drop = liquidationDistance(5, 0.02);
    close(inferredLeverage({ entryPrice: 100, fillPrice: 100 * (1 - drop) }, 0.02)!, 5);
  });

  it('refuses a position with no loss against entry', () => {
    assert.equal(inferredLeverage({ entryPrice: 100, fillPrice: 101 }, 0.02), null);
  });

  it('buckets leverage at the stated edges', () => {
    assert.equal(bucketOf(3.5), '3x');
    assert.equal(bucketOf(3.51), '5x');
    assert.equal(bucketOf(7), '5x');
    assert.equal(bucketOf(15), '10x');
    assert.equal(bucketOf(15.1), 'over 15x');
  });
});

describe('csv reduction', () => {
  const header = 'block_time,user,coin,direction,price,size,side,start_position,closed_pnl,fee,notional';
  const csv = [
    header,
    // A borrower sells 2 BTC in two fills, losing 10,000 against an entry of 105,000 on average.
    '2025-10-10 21:17:00+00:00,0xaaa,BTC,Liquidated Cross Long,100000,1,A,2,-5000,0,100000',
    '2025-10-10 21:17:01+00:00,0xaaa,BTC,Liquidated Cross Long,100000,1,A,1,-5000,0,100000',
    // The liquidator buys, then later sells on the same label.
    '2025-10-10 21:17:00+00:00,0xbbb,BTC,Liquidated Cross Long,100000,2,B,0,0,0,200000',
    '2025-10-10 21:18:00+00:00,0xbbb,BTC,Liquidated Cross Long,90000,2,A,2,1000,0,180000',
    // Out of scope: isolated, and another coin.
    '2025-10-10 21:17:00+00:00,0xccc,BTC,Liquidated Isolated Long,99000,1,A,1,-1,0,99000',
    '2025-10-10 21:17:00+00:00,0xddd,SOL,Liquidated Cross Long,180,1,A,1,-1,0,180',
    '2025-10-10 21:17:00+00:00,0xeee,ETH,Liquidated Cross Long,3500,1,A,1,-100,0,3500',
  ].join('\n');
  const data = reduceCsv(csv);

  it('drops the address that took the other side', () => {
    assert.deepEqual(data.excludedLiquidators, ['0xbbb']);
    assert.ok(!data.positions.some((p) => p.user === '0xbbb'));
  });

  it('aggregates fills and recovers the entry from closed PnL', () => {
    const position = data.positions.find((p) => p.user === '0xaaa')!;
    assert.equal(position.size, 2);
    assert.equal(position.fillPrice, 100000);
    assert.equal(position.entryPrice, 105000);
    assert.equal(position.firstFill, '2025-10-10 21:17:00+00:00');
  });

  it('keeps BTC and ETH cross longs only', () => {
    assert.deepEqual(data.positions.map((p) => `${p.coin}:${p.user}`), ['BTC:0xaaa', 'ETH:0xeee']);
  });

  it('counts a liquidated position toward the top-up that clears the low', () => {
    const summary = summarizeHyperliquid(data);
    const rows = summary.liquidated.filter((r) => r.positions > 0);
    assert.equal(summary.positionsUsed, 2);
    assert.ok(rows.every((r) => Object.keys(r.survivedWithTopUp).length === 4));
  });
});
