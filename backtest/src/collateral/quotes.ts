// Uniswap v3 quotes at landing blocks: the committed format, the landing block for a time, and the
// price of an unwind from the ladder. Pure: no I/O beyond reading the committed file.
//
// Quotes are taken at fixed USDC amounts, LADDER[k] = 10^(k/8) USDC. An amount between two ladder
// points is priced on the straight line between their quotes. For an exact-output swap the
// collateral paid is convex in the USDC received, so the line can only overstate it. Where the
// upper point cannot be filled, the amount itself is quoted. README.md has the rules.
import { join } from 'node:path';
import { BASE_BLOCK_SEC, BASE_GENESIS_TIME, type ChainKey } from '../config.ts';
import { deltaDecode } from '../data.ts';
import { readGz } from '../portfolio/data.ts';
import { COST_UNIT, GAS_PER_UNWIND, LADDER, LADDER_TOP, REPEAT_REVERTS_PRICED, REPEAT_WINDOW_SEC } from './config.ts';
import { COLLATERAL_DIR } from './pools.ts';
import type { Execution, Executor, UnwindRequest } from '../sim/unwind.ts';

export const quotesFile = (chain: ChainKey, period: string): string => join(COLLATERAL_DIR, `quotes-${chain}-${period}.json.gz`);

/** A point quoted on one pool: cost against the oracle in COST_UNIT, or null when the pool could not fill it. */
export type Cost = number | null;

/** One pool at one block: [pool index, gap of the pool price against the oracle in COST_UNIT, ladder ks, their costs, exact points]. */
export type PoolRow = [pool: number, gap: number, ks: number[], costs: Cost[], exact: Array<[amountBase: number, cost: Cost]>];

/** One landing block: [block delta, header time delta, base fee in wei, WETH and USDC prices, [asset, price] pairs, pool rows]. */
export type BlockRow = [blockDelta: number, tDelta: number, baseFeeWei: number, weth: number, usdc: number, assets: Array<[asset: number, price: number]>, pools: PoolRow[]];

export interface QuoteFile {
  chain: ChainKey;
  period: string;
  /** USDC base units of each ladder point. */
  ladder: number[];
  /** Every usable tier in the period. `asset` indexes the period's price file; `token` is its address. */
  pools: Array<{ asset: number; token: string; fee: number; pool: string; decimals: number }>;
  /** Ascending by block. Prices are AaveOracle's, 8 decimals. */
  rows: BlockRow[];
}

export interface PoolQuotes {
  gap: number;
  ladder: Map<number, Cost>;
  exact: Map<number, Cost>;
}

export interface BlockQuotes {
  block: number;
  t: number;
  baseFeeWei: number;
  weth: number;
  usdc: number;
  prices: Map<number, number>;
  pools: Map<number, PoolQuotes>;
}

/** Times of known blocks, for the Arbitrum landing block. Ascending in block, non-decreasing in time. */
export interface Anchors {
  blocks: number[];
  times: number[];
}

/** Integer ceiling of a / b for b > 0. */
const ceilDiv = (a: number, b: number): number => -Math.floor(-a / b);

/**
 * The block an unwind landing at `t` executes in. Base: the first block at or after t. Arbitrum:
 * linear in time between the price-file rows around t, rounded up; past the last row, at the
 * period's mean block time. All in integers, so every reader gets the same block.
 */
export function landingBlock(chain: ChainKey, t: number, anchors: Anchors): number {
  if (chain === 'base') return ceilDiv(t - BASE_GENESIS_TIME, BASE_BLOCK_SEC);
  const { blocks, times } = anchors;
  const last = times.length - 1;
  if (t > times[last]!) return blocks[last]! + ceilDiv((t - times[last]!) * (blocks[last]! - blocks[0]!), times[last]! - times[0]!);
  // First row with time >= t.
  let low = 0;
  let high = last;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (times[mid]! >= t) high = mid;
    else low = mid + 1;
  }
  if (times[low] === t || low === 0) return blocks[low]!;
  const before = low - 1;
  return blocks[before]! + ceilDiv((t - times[before]!) * (blocks[low]! - blocks[before]!), times[low]! - times[before]!);
}

/** Largest k with LADDER[k] <= amountBase. Amounts are at least LADDER[0]. */
export function ladderIndex(amountBase: number): number {
  let low = 0;
  let high = LADDER_TOP;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (LADDER[mid]! <= amountBase) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** What is still needed to price an amount on one pool at one block. */
export interface Need {
  block: number;
  /** The block itself has no row yet: header and oracle are needed too. */
  row: boolean;
  asset: number;
  pool: number;
  ks: number[];
  exact: number | null;
}

/** Collateral units paid for `amountBase` USDC on one pool, 'fail' if it cannot fill it, or what is missing. */
export function amountIn(quotes: PoolQuotes | undefined, amountBase: number, perUsdc: number): number | 'fail' | { ks: number[]; exact: number | null } {
  const at = (base: number, cost: number): number => (base / 1e6) * perUsdc * (1 + cost / COST_UNIT);
  // A pool that cannot fill an amount cannot fill more.
  if (quotes) {
    for (const [k, cost] of quotes.ladder) if (cost === null && LADDER[k]! <= amountBase) return 'fail';
    for (const [base, cost] of quotes.exact) if (cost === null && base <= amountBase) return 'fail';
  }
  const k = ladderIndex(amountBase);
  if (LADDER[k] === amountBase) {
    const cost = quotes?.ladder.get(k);
    if (cost === undefined) return { ks: [k], exact: null };
    return cost === null ? 'fail' : at(amountBase, cost);
  }
  if (k === LADDER_TOP) {
    const cost = quotes?.exact.get(amountBase);
    if (cost === undefined) return { ks: [], exact: amountBase };
    return cost === null ? 'fail' : at(amountBase, cost);
  }
  const low = quotes?.ladder.get(k);
  const high = quotes?.ladder.get(k + 1);
  if (low === undefined || high === undefined) return { ks: [k, k + 1].filter((x) => quotes?.ladder.get(x) === undefined), exact: null };
  if (low === null) return 'fail';
  if (high === null) {
    const cost = quotes!.exact.get(amountBase);
    if (cost === undefined) return { ks: [], exact: amountBase };
    return cost === null ? 'fail' : at(amountBase, cost);
  }
  const a = at(LADDER[k]!, low);
  const b = at(LADDER[k + 1]!, high);
  return a + ((amountBase - LADDER[k]!) / (LADDER[k + 1]! - LADDER[k]!)) * (b - a);
}

export class QuoteBook {
  readonly chain: ChainKey;
  readonly period: string;
  readonly pools: QuoteFile['pools'];
  private readonly rows = new Map<number, BlockQuotes>();
  private readonly poolIndex = new Map<string, number>();

  constructor(
    file: QuoteFile,
    readonly anchors: Anchors,
  ) {
    if (file.ladder.length !== LADDER.length || file.ladder.some((v, i) => v !== LADDER[i])) throw new Error('ladder differs from the code');
    this.chain = file.chain;
    this.period = file.period;
    this.pools = file.pools;
    file.pools.forEach((p, i) => this.poolIndex.set(`${p.asset}:${p.fee}`, i));
    let block = 0;
    let t = 0;
    for (const [db, dt, baseFeeWei, weth, usdc, assets, pools] of file.rows) {
      block += db;
      t += dt;
      this.rows.set(block, {
        block,
        t,
        baseFeeWei,
        weth,
        usdc,
        prices: new Map(assets),
        pools: new Map(pools.map(([pool, gap, ks, costs, exact]) => [pool, { gap, ladder: new Map(ks.map((k, i) => [k, costs[i]!])), exact: new Map(exact) }])),
      });
    }
  }

  pool(asset: number, fee: number): number {
    const index = this.poolIndex.get(`${asset}:${fee}`);
    if (index === undefined) throw new Error(`no pool for asset ${asset} fee ${fee} in ${this.chain} ${this.period}`);
    return index;
  }

  row(block: number): BlockQuotes | undefined {
    return this.rows.get(block);
  }

  blockAt(t: number): number {
    return landingBlock(this.chain, t, this.anchors);
  }

  get size(): number {
    return this.rows.size;
  }
}

export interface ExecutorOptions {
  asset: number;
  /** Fee tiers the helper may use: every usable tier for the main result, the configured one for the sensitivity. */
  fees: number[];
  slippageBps: number;
  /** Called with what is missing. The offline run leaves it out and throws instead. */
  onMissing?: (needs: Need[], request: UnwindRequest) => Execution;
}

/**
 * Prices a run's unwinds. Each is quoted at its landing block, except a repeat revert: once a run
 * has had REPEAT_REVERTS_PRICED reverts in a row, quoted, a further unwind in the same UTC hour as
 * its last quoted one is taken to revert the same way, with the same gas. The first unwind of each
 * new hour is quoted again, and a landing ends the run of reverts. README.md, implementation notes.
 */
export function makeExecutor(book: QuoteBook, options: ExecutorOptions): Executor {
  const quote = quoteAtLanding(book, options);
  let streak = 0;
  let last: { status: Execution['status']; gasUsd: number; landsAt: number } | null = null;
  return (request) => {
    if (last && last.status !== 'landed' && streak >= REPEAT_REVERTS_PRICED && Math.floor(request.landsAt / REPEAT_WINDOW_SEC) === Math.floor(last.landsAt / REPEAT_WINDOW_SEC)) {
      return { status: last.status, block: book.blockAt(request.landsAt), fee: 0, units: 0, paidUsd: 0, receivedUsd: 0, gapUsd: 0, gasUsd: last.gasUsd, standIn: true };
    }
    const e = quote(request);
    last = { status: e.status, gasUsd: e.gasUsd, landsAt: request.landsAt };
    streak = e.status === 'landed' ? 0 : streak + 1;
    return e;
  };
}

/** Prices one unwind at its landing block: the cheapest allowed tier, then the cap against the oracle. */
export function quoteAtLanding(book: QuoteBook, options: ExecutorOptions): Executor {
  const { asset, fees, slippageBps, onMissing } = options;
  const pools = fees.map((fee) => book.pool(asset, fee));
  return (request) => {
    const block = book.blockAt(request.landsAt);
    const row = book.row(block);
    const price = row?.prices.get(asset);
    const missing = (needs: Need[]): Execution => {
      if (!onMissing) throw new Error(`no quote for asset ${asset} at ${book.chain} ${book.period} block ${block}, amount ${request.amount}`);
      return onMissing(needs, request);
    };
    if (!row || price === undefined) {
      return missing(pools.map((pool) => {
        const k = ladderIndex(Math.ceil(request.amount * 1e6));
        return { block, row: !row, asset, pool, ks: [k, k + 1].filter((x) => x <= LADDER_TOP), exact: null };
      }));
    }
    const amountBase = Math.ceil(request.amount * 1e6);
    const perUsdc = row.usdc / price;
    const gasUsd = (GAS_PER_UNWIND * row.baseFeeWei * 1e-18 * row.weth) / 1e8;
    let best: { units: number; pool: number } | null = null;
    const needs: Need[] = [];
    for (const pool of pools) {
      const result = amountIn(row.pools.get(pool), amountBase, perUsdc);
      if (result === 'fail') continue;
      if (typeof result === 'number') {
        if (!best || result < best.units) best = { units: result, pool };
      } else {
        needs.push({ block, row: false, asset, pool, ks: result.ks, exact: result.exact });
      }
    }
    if (needs.length) return missing(needs);
    const base: Execution = { status: 'liquidity', block, fee: 0, units: 0, paidUsd: 0, receivedUsd: 0, gapUsd: 0, gasUsd };
    if (!best) return base;
    const maxIn = request.amount * perUsdc * (1 + slippageBps / 1e4);
    if (best.units > maxIn) return { ...base, status: 'cap' };
    const receivedUsd = (request.amount * row.usdc) / 1e8;
    return {
      ...base,
      status: 'landed',
      fee: book.pools[best.pool]!.fee,
      units: best.units,
      paidUsd: (best.units * price) / 1e8,
      receivedUsd,
      gapUsd: (receivedUsd * row.pools.get(best.pool)!.gap) / COST_UNIT,
    };
  };
}

export const readQuotes = (chain: ChainKey, period: string): QuoteFile => readGz<QuoteFile>(quotesFile(chain, period));

/** Anchors for the landing block, from a period's price file. */
export function anchorsOf(prices: { block: number[]; t: number[] }): Anchors {
  return { blocks: deltaDecode(prices.block), times: deltaDecode(prices.t) };
}
