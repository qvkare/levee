// Uniswap v3 quotes at every landing block a simulated unwind needs. The unwinds depend on the
// quotes (a revert or a sale changes what the keeper does next), so this runs in rounds: simulate
// with what is known, fetch what is missing, repeat until nothing is missing. To save rounds, a
// missing quote is guessed (the same outcome as the run's last unwind) and the run goes on to
// collect more needs; a run with any guess is thrown away and run again next round.
//
// Raw responses go to data/raw/collateral, one line per call, and are re-read on a restart. The
// committed file in data/derived/collateral is encoded from them.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { gzipSync } from 'node:zlib';
import { decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem';
import { CHAINS, type ChainKey } from '../config.ts';
import { COST_UNIT, LADDER, LADDER_TOP } from '../collateral/config.ts';
import { readPools, type PeriodPools } from '../collateral/pools.ts';
import { anchorsOf, makeExecutor, QuoteBook, quotesFile, type BlockRow, type Need, type PoolRow, type QuoteFile } from '../collateral/quotes.ts';
import { allPositions, allPrices, executorOptions, loadContext, marketsOf, memberCases, paramsOf, pathOf, runOne, runsFor, type MemberCase, type PeriodContext, type RunConfig } from '../collateral/runs.ts';
import type { Execution, Executor } from '../sim/unwind.ts';
import { pool as inParallel, Rpc, sleep } from '../rpc.ts';
import { ORACLE_ABI } from './abis.ts';
import { allRanges } from './borrowers.ts';
import { MULTICALL3 } from './multicall.ts';
import { POOL_STATE_ABI, QUOTE_RPCS, quoteCall } from './pools.ts';
import { appendLine, eachLine, rawFile } from './store.ts';

const MULTICALL_ABI = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
]);

/** Quotes per Multicall3 call. Each can cross many ticks, so calls stay small. */
const QUOTES_PER_CALL = 60;
const CONCURRENCY = 8;
/** A block whose fetch fails on rate limits is tried again this many times, after a pause. */
const BLOCK_RETRIES = 40;
/** Guesses a run may make before it stops to wait for quotes. */
const MAX_GUESSES = 400;

/** One raw line: what one call returned at one block. */
export interface RawLine {
  block: number;
  url: string;
  head?: [t: number, baseFeeWei: number];
  oracle?: Array<[asset: number, price: number]>;
  slot0?: Array<[pool: number, sqrtPriceX96: string]>;
  quotes?: Array<[pool: number, amountBase: number, amountIn: string | null]>;
}

interface StoredBlock {
  head?: [number, number];
  oracle: Map<number, number>;
  slot0: Map<number, string>;
  quotes: Map<number, Map<number, string | null>>;
}

export const rawQuotesFile = (chain: ChainKey, period: string): string => rawFile('collateral', `${chain}-${period}.jsonl`);

export class QuoteStore {
  readonly blocks = new Map<number, StoredBlock>();

  add(line: RawLine): void {
    let b = this.blocks.get(line.block);
    if (!b) {
      b = { oracle: new Map(), slot0: new Map(), quotes: new Map() };
      this.blocks.set(line.block, b);
    }
    if (line.head) b.head = line.head;
    for (const [asset, price] of line.oracle ?? []) b.oracle.set(asset, price);
    for (const [pool, sqrt] of line.slot0 ?? []) b.slot0.set(pool, sqrt);
    for (const [pool, amount, amountIn] of line.quotes ?? []) {
      if (!b.quotes.has(pool)) b.quotes.set(pool, new Map());
      b.quotes.get(pool)!.set(amount, amountIn);
    }
  }

  static async load(path: string): Promise<QuoteStore> {
    const store = new QuoteStore();
    for await (const line of eachLine<RawLine>(path)) store.add(line);
    return store;
  }
}

/** The pools a period's quote file lists: every usable tier, by asset then fee. */
export function poolsOf(pools: PeriodPools): QuoteFile['pools'] {
  return pools.assets.flatMap((a) => a.tiers.filter((t) => t.usable).map((t) => ({ asset: a.asset, token: a.address, fee: t.fee, pool: t.pool, decimals: a.decimals })));
}

export function wethIndex(ctx: Pick<PeriodContext, 'model'>, chain: ChainKey): number {
  const weth = chain === 'base' ? '0x4200000000000000000000000000000000000006' : '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
  const i = ctx.model.file.assets.indexOf(weth);
  if (i < 0) throw new Error(`no WETH in ${chain}`);
  return i;
}

/** Collateral per USDC at the pool's price, from slot0, against the oracle's, in COST_UNIT. */
function gapOf(sqrtPriceX96: string | undefined, collateral: string, decimals: number, chain: ChainKey, perUsdc: number): number {
  if (sqrtPriceX96 === undefined) return 0;
  const ratio = (Number(BigInt(sqrtPriceX96)) / 2 ** 96) ** 2;
  const usdc = CHAINS[chain].usdc.toLowerCase();
  // ratio is token1 per token0 in base units. token0 is the lower address.
  const collateralPerUsdc = collateral.toLowerCase() < usdc ? 1 / (ratio * 10 ** (decimals - 6)) : ratio * 10 ** (6 - decimals);
  return Math.round((collateralPerUsdc / perUsdc - 1) * COST_UNIT);
}

/** The committed form of everything fetched so far. Blocks without a header or the USDC and WETH prices are left out. */
export function encodeQuotes(store: QuoteStore, chain: ChainKey, period: string, pools: QuoteFile['pools'], weth: number, usdc: number): QuoteFile {
  const rows: BlockRow[] = [];
  let lastBlock = 0;
  let lastT = 0;
  for (const block of [...store.blocks.keys()].sort((a, b) => a - b)) {
    const b = store.blocks.get(block)!;
    const wethPrice = b.oracle.get(weth);
    const usdcPrice = b.oracle.get(usdc);
    if (!b.head || wethPrice === undefined || usdcPrice === undefined) continue;
    const assets = [...b.oracle.entries()].sort((x, y) => x[0] - y[0]);
    const poolRows: PoolRow[] = [];
    for (const pool of [...b.quotes.keys()].sort((x, y) => x - y)) {
      const info = pools[pool]!;
      const price = b.oracle.get(info.asset);
      if (price === undefined) continue;
      const perUsdc = usdcPrice / price;
      const ks: number[] = [];
      const costs: Array<number | null> = [];
      const exact: Array<[number, number | null]> = [];
      for (const [amount, amountIn] of [...b.quotes.get(pool)!.entries()].sort((x, y) => x[0] - y[0])) {
        const cost = amountIn === null ? null : Math.round((Number(BigInt(amountIn)) / 10 ** info.decimals / ((amount / 1e6) * perUsdc) - 1) * COST_UNIT);
        const k = LADDER.indexOf(amount);
        if (k >= 0) {
          ks.push(k);
          costs.push(cost);
        } else {
          exact.push([amount, cost]);
        }
      }
      poolRows.push([pool, gapOf(b.slot0.get(pool), info.token, info.decimals, chain, perUsdc), ks, costs, exact]);
    }
    rows.push([block - lastBlock, b.head[0] - lastT, b.head[1], wethPrice, usdcPrice, assets, poolRows]);
    lastBlock = block;
    lastT = b.head[0];
  }
  return { chain, period, ladder: LADDER, pools, rows };
}

interface Want {
  head: boolean;
  assets: Set<number>;
  slot0: Set<number>;
  quotes: Set<string>;
}

/** Adds what `needs` lacks to `wants`, quoting every usable tier of the asset. */
function want(wants: Map<number, Want>, needs: Need[], store: QuoteStore, poolsByAsset: Map<number, number[]>, usdc: number, weth: number): void {
  for (const need of needs) {
    const stored = store.blocks.get(need.block);
    let w = wants.get(need.block);
    if (!w) {
      w = { head: false, assets: new Set(), slot0: new Set(), quotes: new Set() };
      wants.set(need.block, w);
    }
    if (!stored?.head) w.head = true;
    for (const asset of [usdc, weth, need.asset]) if (!stored?.oracle.has(asset)) w.assets.add(asset);
    const ks = new Set<number>(need.ks.filter((k) => k >= 0 && k <= LADDER_TOP));
    for (const pool of poolsByAsset.get(need.asset)!) {
      if (!stored?.slot0.has(pool)) w.slot0.add(pool);
      const have = stored?.quotes.get(pool);
      // Above an amount the pool could not fill, nothing more is asked.
      let ceiling = Infinity;
      for (const [amount, amountIn] of have ?? []) if (amountIn === null) ceiling = Math.min(ceiling, amount);
      for (const k of ks) if (!have?.has(LADDER[k]!) && LADDER[k]! < ceiling) w.quotes.add(`${pool}:${LADDER[k]}`);
      if (need.exact !== null && !have?.has(need.exact) && need.exact < ceiling) w.quotes.add(`${pool}:${need.exact}`);
    }
  }
}

interface Encoded {
  target: string;
  callData: `0x${string}`;
  decode: (data: `0x${string}`) => unknown;
}

async function aggregate(rpc: Rpc, block: number, calls: Encoded[]): Promise<{ url: string; results: Array<unknown | null> }> {
  const data = encodeFunctionData({ abi: MULTICALL_ABI, functionName: 'aggregate3', args: [calls.map((c) => ({ target: c.target as `0x${string}`, allowFailure: true, callData: c.callData }))] });
  const { result, url } = await rpc.callTagged<`0x${string}`>('eth_call', [{ to: MULTICALL3, data }, '0x' + block.toString(16)]);
  const decoded = decodeFunctionResult({ abi: MULTICALL_ABI, functionName: 'aggregate3', data: result }) as readonly { success: boolean; returnData: `0x${string}` }[];
  if (decoded.length !== calls.length) throw new Error(`multicall returned ${decoded.length}, wanted ${calls.length}`);
  return {
    url,
    results: decoded.map((r, i) => {
      if (!r.success || r.returnData === '0x') return null;
      try {
        return calls[i]!.decode(r.returnData);
      } catch {
        return null;
      }
    }),
  };
}

function encodeCall(call: { target: string; abi: Parameters<typeof encodeFunctionData>[0]['abi']; functionName: string; args?: readonly unknown[] }): Encoded {
  const callData = encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args ?? [] } as Parameters<typeof encodeFunctionData>[0]);
  return {
    target: call.target,
    callData,
    decode: (data) => decodeFunctionResult({ abi: call.abi, functionName: call.functionName, data } as Parameters<typeof decodeFunctionResult>[0]),
  };
}

/** As `aggregate`, but halves a batch an endpoint refuses for its gas cap. */
async function aggregateSplit(rpc: Rpc, block: number, calls: Encoded[]): Promise<Array<{ url: string; calls: Encoded[]; results: Array<unknown | null> }>> {
  try {
    const { url, results } = await aggregate(rpc, block, calls);
    return [{ url, calls, results }];
  } catch (err) {
    const message = String((err as Error).message).toLowerCase();
    if (calls.length < 2 || !message.includes('gas')) throw err;
    const half = Math.ceil(calls.length / 2);
    return [...(await aggregateSplit(rpc, block, calls.slice(0, half))), ...(await aggregateSplit(rpc, block, calls.slice(half)))];
  }
}

/** A quote that failed inside the multicall, asked again on its own: a revert means the pool cannot fill it. */
async function quoteAlone(rpc: Rpc, block: number, call: Encoded): Promise<string | null> {
  try {
    const { result } = await rpc.callTagged<`0x${string}`>('eth_call', [{ to: call.target, data: call.callData }, '0x' + block.toString(16)]);
    const decoded = call.decode(result) as readonly [bigint];
    return decoded[0].toString();
  } catch (err) {
    if ((err as { fatal?: boolean }).fatal) return null;
    throw err;
  }
}

export interface FetchSetup {
  chain: ChainKey;
  pools: QuoteFile['pools'];
  oracle: string;
  assets: string[];
}

/** Decodes a Multicall3 answer for `calls`. */
function decodeAggregate(result: `0x${string}`, calls: Encoded[]): Array<unknown | null> {
  const decoded = decodeFunctionResult({ abi: MULTICALL_ABI, functionName: 'aggregate3', data: result }) as readonly { success: boolean; returnData: `0x${string}` }[];
  if (decoded.length !== calls.length) throw new Error(`multicall returned ${decoded.length}, wanted ${calls.length}`);
  return decoded.map((r, i) => {
    if (!r.success || r.returnData === '0x') return null;
    try {
      return calls[i]!.decode(r.returnData);
    } catch {
      return null;
    }
  });
}

/**
 * Quote results of one batch. A quote can fail inside a batch for want of gas left by an earlier one,
 * so failures are asked again alone, smallest first per pool. Once one fails alone, every larger
 * amount on that pool fails too: a pool that cannot fill an amount cannot fill more.
 */
async function settleQuotes(rpc: Rpc, block: number, chunk: Array<[number, number]>, calls: Encoded[], results: Array<unknown | null>): Promise<Array<[number, number, string | null]>> {
  const amounts: Array<string | null> = results.map((r) => (r ? (r as readonly [bigint])[0].toString() : null));
  const byPool = new Map<number, number[]>();
  amounts.forEach((a, j) => {
    if (a === null) byPool.set(chunk[j]![0], [...(byPool.get(chunk[j]![0]) ?? []), j]);
  });
  await Promise.all(
    [...byPool.values()].map(async (list) => {
      list.sort((a, b) => chunk[a]![1] - chunk[b]![1]);
      for (const j of list) {
        const alone = await quoteAlone(rpc, block, calls[j]!);
        if (alone === null) break;
        amounts[j] = alone;
      }
    }),
  );
  return chunk.map(([pool, amount], j): [number, number, string | null] => [pool, amount, amounts[j]!]);
}

/**
 * Fetches one block's wants and appends the raw lines. The header, the oracle prices, the pool
 * prices and the first batch of quotes go in one JSON-RPC batch, to spend one request on a new block.
 */
async function fetchBlock(rpc: Rpc, setup: FetchSetup, block: number, w: Want, path: string, store: QuoteStore): Promise<void> {
  const assets = [...w.assets];
  const slots = [...w.slot0];
  const quotes = [...w.quotes].map((key) => key.split(':').map(Number) as [number, number]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const encodeQuote = ([pool, amount]: [number, number]): Encoded => {
    const info = setup.pools[pool]!;
    return encodeCall(quoteCall(setup.chain, setup.assets[info.asset]!, info.fee, BigInt(amount)) as never);
  };
  const lead: Encoded[] = [
    ...assets.map((asset) => encodeCall({ target: setup.oracle, abi: ORACLE_ABI, functionName: 'getAssetPrice', args: [setup.assets[asset]] })),
    ...slots.map((pool) => encodeCall({ target: setup.pools[pool]!.pool, abi: POOL_STATE_ABI, functionName: 'slot0' })),
  ];
  try {
    await fetchFirst(rpc, block, w.head, lead, quotes.slice(0, Math.max(0, QUOTES_PER_CALL - lead.length)), encodeQuote, assets, slots, path, store);
  } catch (err) {
    // An endpoint that refuses the batch for its gas cap gets the prices alone, then smaller batches.
    if (!String((err as Error).message).toLowerCase().includes('gas')) throw err;
    await fetchFirst(rpc, block, w.head, lead, [], encodeQuote, assets, slots, path, store);
    await fetchRest(rpc, block, quotes, encodeQuote, path, store);
    return;
  }
  await fetchRest(rpc, block, quotes.slice(Math.max(0, QUOTES_PER_CALL - lead.length)), encodeQuote, path, store);
}

async function fetchFirst(
  rpc: Rpc,
  block: number,
  needHead: boolean,
  lead: Encoded[],
  firstChunk: Array<[number, number]>,
  encodeQuote: (q: [number, number]) => Encoded,
  assets: number[],
  slots: number[],
  path: string,
  store: QuoteStore,
): Promise<void> {
  const tag = '0x' + block.toString(16);
  const firstCalls = [...lead, ...firstChunk.map(encodeQuote)];
  const line: RawLine = { block, url: '' };
  let results: Array<unknown | null> | null = null;
  if (firstCalls.length) {
    const data = encodeFunctionData({ abi: MULTICALL_ABI, functionName: 'aggregate3', args: [firstCalls.map((c) => ({ target: c.target as `0x${string}`, allowFailure: true, callData: c.callData }))] });
    const params = [{ to: MULTICALL3, data }, tag];
    if (needHead) {
      const { results: answers, url } = await rpc.batchTagged([
        { method: 'eth_getBlockByNumber', params: [tag, false] },
        { method: 'eth_call', params },
      ]);
      const head = answers[0] as { timestamp: string; baseFeePerGas?: string } | null;
      if (!head) throw new Error(`no block ${block}`);
      line.head = [parseInt(head.timestamp, 16), parseInt(head.baseFeePerGas ?? '0x0', 16)];
      line.url = url;
      results = decodeAggregate(answers[1] as `0x${string}`, firstCalls);
    } else {
      const { result, url } = await rpc.callTagged<`0x${string}`>('eth_call', params);
      line.url = url;
      results = decodeAggregate(result, firstCalls);
    }
  } else if (needHead) {
    const { result, url } = await rpc.callTagged<{ timestamp: string; baseFeePerGas?: string } | null>('eth_getBlockByNumber', [tag, false]);
    if (!result) throw new Error(`no block ${block}`);
    line.head = [parseInt(result.timestamp, 16), parseInt(result.baseFeePerGas ?? '0x0', 16)];
    line.url = url;
  }
  if (results) {
    const answer = results;
    line.oracle = assets.map((asset, i): [number, number] => {
      const price = answer[i] as bigint | null;
      if (price === null) throw new Error(`no oracle price for asset ${asset} at ${block}`);
      return [asset, Number(price)];
    });
    line.slot0 = [];
    slots.forEach((pool, i) => {
      const slot = answer[assets.length + i] as readonly [bigint] | null;
      if (slot) line.slot0!.push([pool, slot[0].toString()]);
    });
    line.quotes = await settleQuotes(rpc, block, firstChunk, firstCalls.slice(lead.length), answer.slice(lead.length));
  }
  if (line.url) {
    appendLine(path, line);
    store.add(line);
  }
}

async function fetchRest(rpc: Rpc, block: number, rest: Array<[number, number]>, encodeQuote: (q: [number, number]) => Encoded, path: string, store: QuoteStore): Promise<void> {
  for (let i = 0; i < rest.length; i += QUOTES_PER_CALL) {
    const chunk = rest.slice(i, i + QUOTES_PER_CALL);
    const calls = chunk.map(encodeQuote);
    let offset = 0;
    for (const part of await aggregateSplit(rpc, block, calls)) {
      const sub = chunk.slice(offset, offset + part.calls.length);
      const more: RawLine = { block, url: part.url, quotes: await settleQuotes(rpc, block, sub, part.calls, part.results) };
      offset += part.calls.length;
      appendLine(path, more);
      store.add(more);
    }
  }
}

class Abort extends Error {}

/** A guess for a missing quote: the run's last outcome, at the detection price for a landing. */
function guess(status: Execution['status'], request: { amount: number; price: number; landsAt: number }): Execution {
  const base: Execution = { status, block: 0, fee: 0, units: 0, paidUsd: 0, receivedUsd: 0, gapUsd: 0, gasUsd: 0 };
  if (status !== 'landed') return base;
  const units = (request.amount / request.price) * 1.001;
  return { ...base, fee: 500, units, paidUsd: units * request.price, receivedUsd: request.amount };
}

/** Runs one config against what is known. Returns false if it needed anything. */
function attempt(ctx: PeriodContext, c: MemberCase, path: ReturnType<typeof pathOf>, run: RunConfig, book: QuoteBook, record: (needs: Need[]) => void): boolean {
  let guesses = 0;
  let last: Execution['status'] = 'landed';
  let guessing = false;
  const executor = makeExecutor(book, {
    ...executorOptions(ctx, c, run),
    onMissing: (needs, request) => {
      record(needs);
      guesses++;
      if (guesses > MAX_GUESSES) throw new Abort();
      guessing = true;
      return guess(last, request);
    },
  });
  const tracked: Executor = (request) => {
    guessing = false;
    const e = executor(request);
    if (!guessing) last = e.status;
    return e;
  };
  try {
    runOne(path, paramsOf(ctx, c, run), tracked);
  } catch (err) {
    if (!(err instanceof Abort)) throw err;
  }
  return guesses === 0;
}

export async function fetchQuotes(only?: { chain?: ChainKey; period?: string }): Promise<void> {
  const allPools = readPools();
  const markets = marketsOf();
  const positions = allPositions();
  const prices = allPrices();
  for (const range of allRanges()) {
    if (only?.chain && only.chain !== range.chain) continue;
    if (only?.period && only.period !== range.window) continue;
    const { chain, window: period } = range;
    const started = Date.now();
    const ctx = loadContext(chain, period, allPools, markets, positions, prices);
    const pools = poolsOf(ctx.pools);
    const poolsByAsset = new Map<number, number[]>();
    pools.forEach((p, i) => poolsByAsset.set(p.asset, [...(poolsByAsset.get(p.asset) ?? []), i]));
    const usdc = ctx.model.usdcAsset;
    const weth = wethIndex(ctx, chain);
    const market = markets.find((m) => m.chain === chain && m.window === period && m.block === ctx.model.file.fromBlock)!;
    const setup: FetchSetup = { chain, pools, oracle: market.oracle, assets: ctx.model.file.assets };
    const rawPath = rawQuotesFile(chain, period);
    const store = await QuoteStore.load(rawPath);
    const anchors = anchorsOf(ctx.prices);
    const rpc = new Rpc(QUOTE_RPCS[chain], { timeoutMs: 60_000 });

    const cases = memberCases(ctx).filter((c) => c.simulated);
    let pending: Array<{ c: MemberCase; runs: RunConfig[] }> = cases.map((c) => ({ c, runs: runsFor(c.headline) }));
    console.log(`quotes ${chain} ${period}: ${cases.length} members to simulate, ${pending.reduce((s, p) => s + p.runs.length, 0)} runs, ${store.blocks.size} blocks cached`);
    for (let round = 1; pending.length; round++) {
      const book = new QuoteBook(encodeQuotes(store, chain, period, pools, weth, usdc), anchors);
      const wants = new Map<number, Want>();
      const next: typeof pending = [];
      for (const { c, runs } of pending) {
        const path = pathOf(ctx, c);
        const left = runs.filter((run) => !attempt(ctx, c, path, run, book, (needs) => want(wants, needs, store, poolsByAsset, usdc, weth)));
        if (left.length) next.push({ c, runs: left });
      }
      for (const [block, w] of wants) if (!w.head && !w.assets.size && !w.slot0.size && !w.quotes.size) wants.delete(block);
      const quotes = [...wants.values()].reduce((s, w) => s + w.quotes.size, 0);
      console.log(`  round ${round}: ${next.length} members still need quotes, ${next.reduce((s, p) => s + p.runs.length, 0)} runs; fetching ${wants.size} blocks, ${quotes} quotes (${((Date.now() - started) / 60000).toFixed(1)} min)`);
      if (next.length && wants.size === 0) throw new Error('runs need quotes but nothing is missing from the store: a lookup bug');
      let done = 0;
      await inParallel([...wants.entries()], CONCURRENCY, async ([block, w]) => {
        for (let attempt = 1; ; attempt++) {
          try {
            await fetchBlock(rpc, setup, block, w, rawPath, store);
            break;
          } catch (err) {
            if ((err as { fatal?: boolean }).fatal || attempt >= BLOCK_RETRIES) throw err;
            await sleep(Math.min(60_000, 2_000 * attempt));
            // Ask again only for what is still missing.
            const stored = store.blocks.get(block);
            if (stored?.head) w.head = false;
            for (const asset of [...w.assets]) if (stored?.oracle.has(asset)) w.assets.delete(asset);
            for (const pool of [...w.slot0]) if (stored?.slot0.has(pool)) w.slot0.delete(pool);
            for (const key of [...w.quotes]) {
              const [pool, amount] = key.split(':').map(Number) as [number, number];
              if (stored?.quotes.get(pool)?.has(amount)) w.quotes.delete(key);
            }
          }
        }
        done++;
        if (done % 500 === 0) console.log(`    ${done} of ${wants.size} blocks`);
      });
      pending = next;
    }
    const file = encodeQuotes(store, chain, period, pools, weth, usdc);
    const out = quotesFile(chain, period);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, gzipSync(JSON.stringify(file), { level: 9 }));
    console.log(`  wrote ${out}: ${file.rows.length} blocks (${((Date.now() - started) / 60000).toFixed(1)} min)`);
    console.log(`  endpoints: ${rpc.stats().map((s) => `${new URL(s.url).host} ${s.ok}/${s.fail}`).join(', ')}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name: string): string | undefined => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
  await fetchQuotes({ chain: arg('--chain') as ChainKey | undefined, period: arg('--period') });
}
