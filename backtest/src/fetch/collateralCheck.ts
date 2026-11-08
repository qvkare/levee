// Validation of the committed quotes, as README.md pre-registers it under "Method: repay from
// collateral". Every draw uses a Mulberry32 generator seeded 20261108, one per chain.
//
// 1. Ladder error: 1,000 unwinds per chain from the population runs at T 1.20, quoted again at
//    their exact amount on every usable tier, against the ladder's straight line.
// 2. Second endpoint: 500 landing blocks per chain, every call re-read on another endpoint.
// 3. Real swaps: 1,000 landing blocks per chain where an unwind landed. Every swap in a quoted pool
//    in that block that took USDC out is quoted again at the block before, on that pool, for its
//    USDC amount, and the collateral quoted is compared with the collateral the swap paid.
// 4. Repeat reverts: 1,000 unwinds per chain that were taken to revert without a quote, quoted at
//    their own landing blocks (README.md, implementation notes).
//
// Writes data/derived/collateral/validation.json, which `pnpm backtest` shows in collateral.md.
import { join } from 'node:path';
import { decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem';
import { CHAINS, CALM_ID, WINDOWS, type ChainKey } from '../config.ts';
import { COST_UNIT, VALIDATION_SEED } from '../collateral/config.ts';
import { COLLATERAL_DIR, readPools } from '../collateral/pools.ts';
import { amountIn, anchorsOf, QuoteBook, readQuotes } from '../collateral/quotes.ts';
import { allPositions, allPrices, collectUnwinds, loadContext, marketsOf, POPULATION_RUNS, BASE, type UnwindRecord } from '../collateral/runs.ts';
import { existsSync, readJson, writeJson } from '../paths.ts';
import { mulberry32 } from '../portfolio/random.ts';
import { pool as inParallel, Rpc } from '../rpc.ts';
import { ORACLE_ABI } from './abis.ts';
import { MULTICALL3 } from './multicall.ts';
import { POOL_STATE_ABI, QUOTE_RPCS, quoteCall } from './pools.ts';
import { rawQuotesFile, type RawLine } from './quotes.ts';
import { eachLine } from './store.ts';

const PERIODS = [...WINDOWS.map((w) => w.id), CALM_ID];
const LADDER_SAMPLE = 1_000;
const ENDPOINT_SAMPLE = 500;
const SWAP_SAMPLE = 1_000;
const STAND_IN_SAMPLE = 1_000;
const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
/** Log providers: Pocket Network drops logs (README, Data sources), so it is not used. */
const LOG_RPCS: Record<ChainKey, string[]> = {
  base: ['https://gateway.tenderly.co/public/base', 'https://base.gateway.tenderly.co', 'https://mainnet.base.org'],
  arbitrum: ['https://gateway.tenderly.co/public/arbitrum', 'https://arbitrum.gateway.tenderly.co', 'https://arb1.arbitrum.io/rpc'],
};

const MULTICALL_ABI = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
]);

/** Draws `n` items without replacement: a Fisher-Yates shuffle with the generator, then the first n. */
function draw<T>(items: T[], n: number, random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, n);
}

interface Call {
  target: string;
  data: `0x${string}`;
}

async function multicallRaw(rpc: Rpc, block: number, calls: Call[], avoid?: string): Promise<{ url: string; results: Array<`0x${string}` | null> }> {
  const data = encodeFunctionData({ abi: MULTICALL_ABI, functionName: 'aggregate3', args: [calls.map((c) => ({ target: c.target as `0x${string}`, allowFailure: true, callData: c.data }))] });
  const { result, url } = await rpc.callTagged<`0x${string}`>('eth_call', [{ to: MULTICALL3, data }, '0x' + block.toString(16)], avoid);
  const decoded = decodeFunctionResult({ abi: MULTICALL_ABI, functionName: 'aggregate3', data: result }) as readonly { success: boolean; returnData: `0x${string}` }[];
  return { url, results: decoded.map((r) => (r.success && r.returnData !== '0x' ? r.returnData : null)) };
}

const quoteData = (chain: ChainKey, token: string, fee: number, amount: bigint): Call => {
  const c = quoteCall(chain, token, fee, amount);
  return { target: c.target, data: encodeFunctionData({ abi: c.abi, functionName: c.functionName, args: c.args } as never) };
};

/** As `multicallRaw`, halving a batch an endpoint refuses for its gas cap. */
async function multicallSplit(rpc: Rpc, block: number, calls: Call[], avoid?: string): Promise<{ urls: string[]; results: Array<`0x${string}` | null> }> {
  try {
    const { url, results } = await multicallRaw(rpc, block, calls, avoid);
    return { urls: [url], results };
  } catch (err) {
    if (calls.length < 2 || !String((err as Error).message).toLowerCase().includes('gas')) throw err;
    const half = Math.ceil(calls.length / 2);
    const a = await multicallSplit(rpc, block, calls.slice(0, half), avoid);
    const b = await multicallSplit(rpc, block, calls.slice(half), avoid);
    return { urls: [...a.urls, ...b.urls], results: [...a.results, ...b.results] };
  }
}

/** The quoted collateral in, or null; a failure inside the batch is asked again on its own. */
async function quoteAmounts(rpc: Rpc, block: number, calls: Call[], avoid?: string): Promise<{ urls: string[]; amounts: Array<bigint | null> }> {
  const out: Array<bigint | null> = [];
  const urls: string[] = [];
  for (let i = 0; i < calls.length; i += 30) {
    const chunk = calls.slice(i, i + 30);
    const { urls: used, results } = await multicallSplit(rpc, block, chunk, avoid);
    urls.push(...used);
    for (const [j, r] of results.entries()) {
      if (r) {
        out.push(BigInt(r.slice(0, 66)));
        continue;
      }
      try {
        const alone = await rpc.callTagged<`0x${string}`>('eth_call', [{ to: chunk[j]!.target, data: chunk[j]!.data }, '0x' + block.toString(16)], avoid);
        out.push(BigInt(alone.result.slice(0, 66)));
      } catch (err) {
        if (!(err as { fatal?: boolean }).fatal) throw err;
        out.push(null);
      }
    }
  }
  return { urls, amounts: out };
}

const stats = (values: number[]): { n: number; median: number; p95: number; max: number } => {
  const s = [...values].sort((a, b) => a - b);
  const q = (x: number): number => (s.length ? s[Math.min(s.length - 1, Math.floor(x * s.length))]! : NaN);
  return { n: s.length, median: q(0.5), p95: q(0.95), max: s[s.length - 1] ?? NaN };
};
const fmt = (x: number, digits = 2): string => (Number.isFinite(x) ? x.toFixed(digits) : 'n/a');

/** `only` re-runs one chain and keeps the other chain's rows from the existing file. */
export async function validateQuotes(only?: ChainKey): Promise<void> {
  const allPools = readPools();
  const markets = marketsOf();
  const positions = allPositions();
  const prices = allPrices();
  const runs = POPULATION_RUNS.filter((r) => r.trigger === BASE.trigger && r.tier === 'cheapest');
  const rows: Array<{ check: string; chain: ChainKey; n: number; result: string }> = [];
  const detail: Record<string, unknown> = {};

  for (const chain of ['arbitrum', 'base'] as ChainKey[]) {
    if (only && chain !== only) continue;
    const random = mulberry32(VALIDATION_SEED);
    const books = new Map<string, QuoteBook>();
    const unwinds: UnwindRecord[] = [];
    for (const period of PERIODS) {
      const ctx = loadContext(chain, period, allPools, markets, positions, prices);
      const book = new QuoteBook(readQuotes(chain, period), anchorsOf(ctx.prices));
      books.set(period, book);
      for (const u of collectUnwinds(ctx, book, runs)) unwinds.push(u);
    }
    console.log(`validate ${chain}: ${unwinds.length} unwinds at T 1.20`);
    const rpc = new Rpc(QUOTE_RPCS[chain], { timeoutMs: 60_000 });

    // 1. Ladder against an exact quote.
    const ladderErrors: number[] = [];
    let overstated = 0;
    // Where the line is below the exact quote, with one base unit of the asset in bps of the amount paid.
    const under: Array<{ bps: number; usdc: number; asset: number; period: string; block: number; unitBps: number }> = [];
    const flips: Record<string, number> = { '100': 0, '300': 0 };
    const quoted = unwinds.filter((u) => !u.standIn);
    const sample = draw(quoted, LADDER_SAMPLE, random);
    await inParallel(sample, 8, async (u) => {
      const book = books.get(u.period)!;
      const row = book.row(u.block)!;
      const price = row.prices.get(u.asset)!;
      const perUsdc = row.usdc / price;
      const base = Math.ceil(u.amount * 1e6);
      const pools = u.fees.map((fee) => book.pool(u.asset, fee));
      const { amounts } = await quoteAmounts(rpc, u.block, pools.map((p) => quoteData(chain, book.pools[p]!.token, book.pools[p]!.fee, BigInt(base))));
      let exact: number | null = null;
      let ladder: number | null = null;
      pools.forEach((p, i) => {
        const e = amounts[i];
        if (e !== null && e !== undefined) {
          const units = Number(e) / 10 ** book.pools[p]!.decimals;
          if (exact === null || units < exact) exact = units;
        }
        const l = amountIn(row.pools.get(p), base, perUsdc);
        if (typeof l === 'number' && (ladder === null || l < ladder)) ladder = l;
      });
      if (exact === null || ladder === null) return;
      const err = ((ladder as number) / (exact as number) - 1) * 1e4;
      ladderErrors.push(err);
      if (err >= -1e-6) overstated++;
      else under.push({ bps: err, usdc: u.amount, asset: u.asset, period: u.period, block: u.block, unitBps: 1e4 / 10 ** book.pools[pools[0]!]!.decimals / (exact as number) });
      for (const cap of [100, 300]) {
        const maxIn = u.amount * perUsdc * (1 + cap / 1e4);
        if ((ladder <= maxIn) !== ((exact as number) <= maxIn)) flips[String(cap)]!++;
      }
    });
    const le = stats(ladderErrors.map(Math.abs));
    const below = stats(under.map((x) => -x.bps));
    const withinUnit = under.filter((x) => -x.bps <= x.unitBps + 1e-9).length;
    rows.push({
      check: 'Ladder price against an exact quote of the same unwind, cheapest tier, |difference| in bps',
      chain,
      n: le.n,
      result: `median ${fmt(le.median, 3)}, p95 ${fmt(le.p95, 3)}, max ${fmt(le.max, 2)}. Ladder at or above the exact quote in ${overstated} of ${le.n}; below it in ${under.length}, by at most ${fmt(below.max, 3)} bps, ${withinUnit} of them by no more than one base unit of the asset. Cap decision changed: ${flips['100']} at 100 bps, ${flips['300']} at 300 bps`,
    });
    detail[`${chain}:ladder`] = { ...le, overstated, flips, below, withinUnit, under: [...under].sort((a, b) => a.bps - b.bps).slice(0, 20) };

    // 2. Second endpoint.
    const blocks = [...new Set(quoted.map((u) => `${u.period}:${u.block}`))].sort();
    const endpointSample = draw(blocks, ENDPOINT_SAMPLE, random);
    const wanted = new Map<string, Set<number>>();
    for (const key of endpointSample) {
      const [period, block] = key.split(':') as [string, string];
      if (!wanted.has(period)) wanted.set(period, new Set());
      wanted.get(period)!.add(Number(block));
    }
    const lines: Array<{ period: string; line: RawLine }> = [];
    for (const [period, set] of wanted) for await (const line of eachLine<RawLine>(rawQuotesFile(chain, period))) if (set.has(line.block)) lines.push({ period, line });
    let compared = 0;
    let mismatches = 0;
    let sameEndpoint = 0;
    const examples: unknown[] = [];
    await inParallel(lines, 8, async ({ period, line }) => {
      const book = books.get(period)!;
      const market = markets.find((m) => m.chain === chain && m.window === period && m.block === allPools.find((p) => p.chain === chain && p.period === period)!.block)!;
      const assets = prices.find((p) => p.chain === chain && p.window === period)!.series.map((x) => x.asset);
      const note = (what: string, a: unknown, b: unknown): void => {
        compared++;
        if (String(a) !== String(b)) {
          mismatches++;
          if (examples.length < 10) examples.push({ chain, period, block: line.block, what, stored: a, again: b });
        }
      };
      if (line.head) {
        const read = (): Promise<{ result: { timestamp: string; baseFeePerGas?: string }; url: string }> =>
          rpc.callTagged<{ timestamp: string; baseFeePerGas?: string }>('eth_getBlockByNumber', ['0x' + line.block.toString(16), false], line.url);
        let answer = await read();
        for (let i = 0; i < 5 && answer.url === line.url; i++) answer = await read();
        const { result, url } = answer;
        if (url === line.url) sameEndpoint++;
        note('time', line.head[0], parseInt(result.timestamp, 16));
        note('base fee', line.head[1], parseInt(result.baseFeePerGas ?? '0x0', 16));
      }
      const calls: Call[] = [];
      for (const [asset] of line.oracle ?? []) calls.push({ target: market.oracle, data: encodeFunctionData({ abi: ORACLE_ABI, functionName: 'getAssetPrice', args: [assets[asset] as `0x${string}`] }) });
      for (const [pool] of line.slot0 ?? []) calls.push({ target: book.pools[pool]!.pool, data: encodeFunctionData({ abi: POOL_STATE_ABI, functionName: 'slot0' }) });
      if (calls.length) {
        const { url, results } = await multicallRaw(rpc, line.block, calls, line.url);
        if (url === line.url) sameEndpoint++;
        (line.oracle ?? []).forEach(([, price], i) => note('oracle', price, results[i] ? BigInt(results[i]!) : null));
        (line.slot0 ?? []).forEach(([, sqrt], i) => {
          const r = results[(line.oracle ?? []).length + i];
          note('slot0', sqrt, r ? BigInt(r.slice(0, 66)) : null);
        });
      }
      if (line.quotes?.length) {
        const { urls, amounts } = await quoteAmounts(
          rpc,
          line.block,
          line.quotes.map(([pool, amount]) => quoteData(chain, book.pools[pool]!.token, book.pools[pool]!.fee, BigInt(amount))),
          line.url,
        );
        if (urls.includes(line.url)) sameEndpoint++;
        line.quotes.forEach(([, , stored], i) => note('quote', stored, amounts[i] === null ? null : amounts[i]!.toString()));
      }
    });
    rows.push({
      check: 'Every header, oracle price, pool price and quote of a sampled landing block, read again on a different endpoint',
      chain,
      n: compared,
      result: `${endpointSample.length} blocks, ${compared} values, ${mismatches} differ. ${sameEndpoint} calls could only be answered by the same endpoint`,
    });
    detail[`${chain}:endpoint`] = { blocks: endpointSample.length, compared, mismatches, sameEndpoint, examples };

    // 3. Real swaps in landing blocks.
    const landedBlocks = [...new Set(unwinds.filter((u) => u.status === 'landed').map((u) => `${u.period}:${u.block}:${u.asset}`))].sort();
    const swapSample = draw(landedBlocks, SWAP_SAMPLE, random);
    const logRpc = new Rpc(LOG_RPCS[chain], { timeoutMs: 60_000 });
    const first: number[] = [];
    const later: number[] = [];
    let withSwap = 0;
    let swaps = 0;
    const usdc = CHAINS[chain].usdc.toLowerCase();
    await inParallel(swapSample, 6, async (key) => {
      const [period, blockText, assetText] = key.split(':') as [string, string, string];
      const block = Number(blockText);
      const book = books.get(period)!;
      const pools = book.pools.map((p, i) => ({ ...p, index: i })).filter((p) => p.asset === Number(assetText));
      const logs = await logRpc.call<Array<{ address: string; topics: string[]; data: string; logIndex: string }>>('eth_getLogs', [
        { fromBlock: '0x' + block.toString(16), toBlock: '0x' + block.toString(16), address: pools.map((p) => p.pool) },
      ]);
      let any = false;
      for (const pool of pools) {
        const own = logs.filter((l) => l.address.toLowerCase() === pool.pool).sort((a, b) => parseInt(a.logIndex, 16) - parseInt(b.logIndex, 16));
        for (const [i, log] of own.entries()) {
          if (log.topics[0] !== SWAP_TOPIC) continue;
          const amount0 = BigInt.asIntN(256, BigInt('0x' + log.data.slice(2, 66)));
          const amount1 = BigInt.asIntN(256, BigInt('0x' + log.data.slice(66, 130)));
          const usdcIsToken0 = usdc < pool.token.toLowerCase();
          const usdcDelta = usdcIsToken0 ? amount0 : amount1;
          const collateralDelta = usdcIsToken0 ? amount1 : amount0;
          if (usdcDelta >= 0n || collateralDelta <= 0n) continue;
          any = true;
          swaps++;
          const { amounts } = await quoteAmounts(rpc, block - 1, [quoteData(chain, pool.token, pool.fee, -usdcDelta)]);
          if (amounts[0] === null || amounts[0] === undefined) continue;
          const diff = Math.abs((Number(amounts[0]) / Number(collateralDelta) - 1) * 1e4);
          (i === 0 ? first : later).push(diff);
        }
      }
      if (any) withSwap++;
    });
    const f = stats(first);
    const l = stats(later);
    rows.push({
      check: 'Real swaps that took USDC out of a quoted pool in a sampled landing block, against the same USDC quoted at the block before, |difference| in bps',
      chain,
      n: swaps,
      result: `${swapSample.length} blocks, ${withSwap} with such a swap. First event of its pool in the block: n ${f.n}, median ${fmt(f.median, 4)}, p95 ${fmt(f.p95, 4)}, max ${fmt(f.max, 3)}, ${first.filter((x) => x <= 0.1).length} within 0.1 bps. After another event of its pool in the same block: n ${l.n}, median ${fmt(l.median, 2)}, p95 ${fmt(l.p95, 2)}`,
    });
    detail[`${chain}:swaps`] = { blocks: swapSample.length, withSwap, swaps, first: f, later: l, firstWithin01: first.filter((x) => x <= 0.1).length };

    // 4. Repeat reverts taken without a quote, quoted at their own landing blocks.
    const standIns = draw(
      unwinds.filter((u) => u.standIn),
      STAND_IN_SAMPLE,
      random,
    );
    const outcomes: Record<string, number> = { same: 0, landed: 0, other: 0 };
    await inParallel(standIns, 8, async (u) => {
      const book = books.get(u.period)!;
      const market = markets.find((m) => m.chain === chain && m.window === u.period && m.block === allPools.find((p) => p.chain === chain && p.period === u.period)!.block)!;
      const assets = prices.find((p) => p.chain === chain && p.window === u.period)!.series.map((x) => x.asset);
      const usdcIndex = assets.indexOf(CHAINS[chain].usdc.toLowerCase());
      const oracle = await multicallRaw(rpc, u.block, [usdcIndex, u.asset].map((a) => ({ target: market.oracle, data: encodeFunctionData({ abi: ORACLE_ABI, functionName: 'getAssetPrice', args: [assets[a] as `0x${string}`] }) })));
      const usdcPrice = Number(BigInt(oracle.results[0]!));
      const assetPrice = Number(BigInt(oracle.results[1]!));
      const pools = u.fees.map((fee) => book.pools[book.pool(u.asset, fee)]!);
      const { amounts } = await quoteAmounts(rpc, u.block, pools.map((p) => quoteData(chain, p.token, p.fee, BigInt(Math.ceil(u.amount * 1e6)))));
      let best: number | null = null;
      pools.forEach((p, i) => {
        const a = amounts[i];
        if (a !== null && a !== undefined && (best === null || Number(a) / 10 ** p.decimals < best)) best = Number(a) / 10 ** p.decimals;
      });
      const maxIn = u.amount * (usdcPrice / assetPrice) * (1 + u.slippageBps / 1e4);
      const status = best === null ? 'liquidity' : best > maxIn ? 'cap' : 'landed';
      outcomes[status === u.status ? 'same' : status === 'landed' ? 'landed' : 'other']!++;
    });
    rows.push({
      check: 'Repeat reverts taken without a quote, quoted at their own landing blocks',
      chain,
      n: standIns.length,
      result: `${outcomes['same']} revert the same way, ${outcomes['other']} revert the other way, ${outcomes['landed']} would have landed`,
    });
    detail[`${chain}:standIns`] = { n: standIns.length, outcomes, population: unwinds.filter((u) => u.standIn).length };
    console.log(rows.filter((r) => r.chain === chain).map((r) => `  ${r.check}: ${r.result}`).join('\n'));
  }
  const file = join(COLLATERAL_DIR, 'validation.json');
  if (only && existsSync(file)) {
    const old = readJson<{ rows: typeof rows; detail: Record<string, unknown> }>(file);
    rows.unshift(...old.rows.filter((r) => r.chain !== only));
    for (const [key, value] of Object.entries(old.detail)) if (!key.startsWith(`${only}:`)) detail[key] = value;
  }
  rows.sort((a, b) => (a.chain < b.chain ? -1 : a.chain > b.chain ? 1 : 0));
  writeJson(file, { seed: VALIDATION_SEED, costUnit: COST_UNIT, rows, detail });
}

if (import.meta.url === `file://${process.argv[1]}`) await validateQuotes(process.argv.includes('--chain') ? (process.argv[process.argv.indexOf('--chain') + 1] as ChainKey) : undefined);
