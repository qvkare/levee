import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LADDER } from '../src/collateral/config.ts';
import { amountIn, ladderIndex, landingBlock, makeExecutor, QuoteBook, type QuoteFile } from '../src/collateral/quotes.ts';

const close = (actual: unknown, expected: number, tolerance = 1e-9): void =>
  assert.ok(typeof actual === 'number' && Math.abs(actual - expected) < tolerance, `${String(actual)} is not ${expected}`);

describe('the landing block', () => {
  it('is the first Base block at or after the time, two seconds a block from genesis', () => {
    // Genesis 1,686,789,347. Time +100 is block 50; +101 rounds up to 51.
    assert.equal(landingBlock('base', 1_686_789_447, { blocks: [], times: [] }), 50);
    assert.equal(landingBlock('base', 1_686_789_448, { blocks: [], times: [] }), 51);
  });
  it('interpolates Arbitrum between known blocks and rounds up', () => {
    const anchors = { blocks: [1000, 1040, 1100], times: [500, 510, 520] };
    assert.equal(landingBlock('arbitrum', 510, anchors), 1040);
    // 3 s into a 10 s gap of 60 blocks: 18 blocks.
    assert.equal(landingBlock('arbitrum', 513, anchors), 1058);
    // 2.5 s into a 10 s gap of 40 blocks: 10 blocks, then 1 more when it does not divide.
    assert.equal(landingBlock('arbitrum', 503, anchors), 1012);
  });
  it('extrapolates past the last known block at the mean block time', () => {
    // 100 blocks in 20 s: 5 a second. 7 s past the last row is 35 blocks.
    assert.equal(landingBlock('arbitrum', 527, { blocks: [1000, 1040, 1100], times: [500, 510, 520] }), 1135);
  });
});

describe('the ladder', () => {
  it('runs from 1 USDC to 100M USDC, eight steps a decade', () => {
    assert.equal(LADDER[0], 1_000_000);
    assert.equal(LADDER[8], 10_000_000);
    assert.equal(LADDER[64], 100_000_000_000_000);
    assert.equal(LADDER[1], 1_333_521);
  });
  it('finds the point at or below an amount', () => {
    assert.equal(ladderIndex(1_000_000), 0);
    assert.equal(ladderIndex(1_333_520), 0);
    assert.equal(ladderIndex(1_333_521), 1);
    assert.equal(ladderIndex(10_000_001), 8);
  });
});

describe('pricing an amount from the ladder', () => {
  // One pool: costs of 10 bps at 10 USDC, 30 bps at 13.335 USDC, and a fill failure at 17.78 USDC.
  const pool = {
    gap: 0,
    ladder: new Map<number, number | null>([
      [8, 10_000],
      [9, 30_000],
      [10, null],
    ]),
    exact: new Map<number, number | null>([[15_000_000, 50_000]]),
  };
  it('uses a ladder point as it is', () => {
    // 10 USDC at 2 units a USDC, 10 bps over: 20.02 units.
    close(amountIn(pool, 10_000_000, 2), 20.02);
  });
  it('prices between two points on the straight line', () => {
    const a = 10 * 2 * 1.001;
    const b = (LADDER[9]! / 1e6) * 2 * 1.003;
    const x = 12_000_000;
    close(amountIn(pool, x, 2), a + ((x - 10_000_000) / (LADDER[9]! - 10_000_000)) * (b - a));
  });
  it('asks for the amount itself when the upper point cannot be filled', () => {
    assert.deepEqual(amountIn(pool, 16_000_000, 2), { ks: [], exact: 16_000_000 });
    close(amountIn(pool, 15_000_000, 2), 15 * 2 * 1.005);
  });
  it('fails above a point that cannot be filled', () => {
    assert.equal(amountIn(pool, 20_000_000, 2), 'fail');
  });
  it('fails above any amount the pool could not fill, without asking for more points', () => {
    assert.equal(amountIn(pool, LADDER[20]!, 2), 'fail');
  });
  it('asks for missing ladder points', () => {
    assert.deepEqual(amountIn(pool, 2_000_000, 2), { ks: [2, 3], exact: null });
  });
});

describe('the executor', () => {
  // Block 100 at t=1,000: asset 0 at $2,000, USDC at $1, WETH at $2,000, base fee 0.1 gwei.
  // Two tiers. The 500 tier costs 20 bps on every ladder point, the 3000 tier 40 bps.
  const ks = Array.from({ length: 65 }, (_, k) => k);
  const file: QuoteFile = {
    chain: 'base',
    period: 'test',
    ladder: LADDER,
    pools: [
      { asset: 0, token: '0x4200000000000000000000000000000000000006', fee: 500, pool: '0xa', decimals: 18 },
      { asset: 0, token: '0x4200000000000000000000000000000000000006', fee: 3000, pool: '0xb', decimals: 18 },
    ],
    rows: [
      [
        100,
        1000,
        100_000_000,
        200_000_000_000,
        100_000_000,
        [[0, 200_000_000_000]],
        [
          [0, 500, ks, ks.map(() => 20_000), []],
          [1, -1_000, ks, ks.map(() => 40_000), []],
        ],
      ],
    ],
  };
  const book = new QuoteBook(file, { blocks: [], times: [] });
  // Base block 100 is at genesis + 200 s.
  const request = { detectedAt: 0, landsAt: 1_686_789_347 + 199, amount: 5000, price: 2000 };

  it('takes the cheapest tier and charges gas at the base fee', () => {
    const e = makeExecutor(book, { asset: 0, fees: [500, 3000], slippageBps: 100 })(request);
    assert.equal(e.status, 'landed');
    assert.equal(e.fee, 500);
    assert.equal(e.block, 100);
    // 5,000 USDC at $2,000 is 2.5 units; 20 bps over: 2.505 units, $5,010.
    close(e.units, 2.505);
    close(e.paidUsd - e.receivedUsd, 10, 1e-6);
    // The pool price is 0.5 bps over the oracle: $0.25 of the $10.
    close(e.gapUsd, 0.25, 1e-9);
    // 600,000 gas × 0.1 gwei × $2,000 = $0.12.
    close(e.gasUsd, 0.12, 1e-12);
  });
  it('uses only the configured tier when told to', () => {
    const e = makeExecutor(book, { asset: 0, fees: [3000], slippageBps: 100 })(request);
    close(e.units, 2.51);
  });
  it('reverts when the quote is worse than the cap', () => {
    const e = makeExecutor(book, { asset: 0, fees: [3000], slippageBps: 30 })(request);
    assert.equal(e.status, 'cap');
    assert.equal(e.units, 0);
    close(e.gasUsd, 0.12, 1e-12);
  });
  it('throws offline when a block was never quoted', () => {
    assert.throws(() => makeExecutor(book, { asset: 0, fees: [500], slippageBps: 100 })({ ...request, landsAt: request.landsAt + 10 }));
  });
});

describe('repeat reverts', () => {
  // Every quote costs 400 bps, over a 100 bps cap. Rows at Base blocks 100 and 1,900, an hour apart.
  const ks = Array.from({ length: 65 }, (_, k) => k);
  const row = (blockDelta: number): QuoteFile['rows'][number] => [
    blockDelta,
    blockDelta * 2,
    100_000_000,
    200_000_000_000,
    100_000_000,
    [[0, 200_000_000_000]],
    [[0, 0, ks, ks.map(() => 400_000), []]],
  ];
  const file: QuoteFile = {
    chain: 'base',
    period: 'test',
    ladder: LADDER,
    pools: [{ asset: 0, token: '0x4200000000000000000000000000000000000006', fee: 500, pool: '0xa', decimals: 18 }],
    rows: [row(100), row(1800)],
  };
  const book = new QuoteBook(file, { blocks: [], times: [] });
  const at = (block: number): number => 1_686_789_347 + 2 * block - 1;

  it('quotes five reverts in a row, then stands in for the rest of the hour, then quotes the next hour', () => {
    const execute = makeExecutor(book, { asset: 0, fees: [500], slippageBps: 100 });
    // The first five land in block 100. The next two land later in the same UTC hour, where no quote is needed.
    const landing = [at(100), at(100), at(100), at(100), at(100), at(100) + 60, at(100) + 120, at(1900)];
    const hour = (t: number): number => Math.floor(t / 3600);
    assert.equal(hour(landing[6]!), hour(landing[0]!));
    assert.notEqual(hour(landing[7]!), hour(landing[0]!));
    const results = landing.map((landsAt) => execute({ detectedAt: landsAt - 60, landsAt, amount: 1000, price: 2000 }));
    assert.deepEqual(
      results.map((e) => e.status),
      ['cap', 'cap', 'cap', 'cap', 'cap', 'cap', 'cap', 'cap'],
    );
    assert.deepEqual(
      results.map((e) => e.standIn === true),
      [false, false, false, false, false, true, true, false],
    );
    close(results[5]!.gasUsd, results[4]!.gasUsd);
  });
});
