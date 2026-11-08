// Every reserve's liquidity and variable borrow index, and its supply and borrow rates, about
// once an hour through each period. Indexes grow balances between re-reads, so interest is in
// the path. USDC's rates give the carry.
import { CHAINS, INDEX_STEP_SEC, type ChainKey } from '../config.ts';
import { pool, Rpc } from '../rpc.ts';
import { MULTICALL3_ABI, POOL_ABI } from './abis.ts';
import { marketsFor } from './actions.ts';
import type { BlockRange } from './blocks.ts';
import { allRanges } from './borrowers.ts';
import { multicall, MULTICALL3, type Call } from './multicall.ts';
import { appendLine, eachLine, rawFile } from './store.ts';

/** Per reserve, in market order: normalized income, normalized variable debt (both ray), supply APR, borrow APR (ray). */
export type IndexRow = [block: number, t: number, reserves: Array<[income: string, debt: string, supplyRate: string, borrowRate: string]>];

const indexRaw = (range: BlockRange): string => rawFile('population', `indexes-${range.chain}-${range.window}.jsonl`);

/** Hourly sample blocks. Base's are exact; Arbitrum's are spaced evenly by block number. */
export function indexBlocks(range: BlockRange): number[] {
  const steps = Math.ceil((range.toTimestamp - range.fromTimestamp) / INDEX_STEP_SEC);
  const blocks: number[] = [];
  for (let k = 0; k <= steps; k++) blocks.push(Math.min(range.toBlock, range.fromBlock + Math.round(((range.toBlock - range.fromBlock) * k) / steps)));
  return [...new Set(blocks)];
}

export async function readIndexes(range: BlockRange): Promise<IndexRow[]> {
  const rows = new Map<number, IndexRow>();
  for await (const row of eachLine<IndexRow>(indexRaw(range))) rows.set(row[0], row);
  return [...rows.values()].sort((a, b) => a[0] - b[0]);
}

export function indexCalls(chain: ChainKey, assets: string[]): Call[] {
  const target = CHAINS[chain].pool;
  return [
    { target: MULTICALL3, abi: MULTICALL3_ABI, functionName: 'getCurrentBlockTimestamp' },
    ...assets.flatMap((asset) => [
      { target, abi: POOL_ABI, functionName: 'getReserveNormalizedIncome', args: [asset] },
      { target, abi: POOL_ABI, functionName: 'getReserveNormalizedVariableDebt', args: [asset] },
      { target, abi: POOL_ABI, functionName: 'getReserveData', args: [asset] },
    ]),
  ];
}

export function decodeIndexCalls(block: number, results: unknown[], assets: string[]): IndexRow {
  const t = Number(results[0] as bigint);
  return [
    block,
    t,
    assets.map((asset, i) => {
      const income = results[1 + i * 3] as bigint | null;
      const debt = results[2 + i * 3] as bigint | null;
      const data = results[3 + i * 3] as readonly unknown[] | null;
      if (income === null || debt === null || data === null) throw new Error(`no index for ${asset} at ${block}`);
      return [income.toString(), debt.toString(), (data[2] as bigint).toString(), (data[4] as bigint).toString()];
    }),
  ];
}

export async function fetchIndexes(only?: ChainKey): Promise<void> {
  for (const range of allRanges()) {
    if (only && range.chain !== only) continue;
    const assets = marketsFor(range).find((m) => m.block === range.fromBlock)!.reserves.map((r) => r.asset);
    const known = new Set((await readIndexes(range)).map((row) => row[0]));
    const todo = indexBlocks(range).filter((b) => !known.has(b));
    console.log(`${range.chain} ${range.window}: ${todo.length} index reads`);
    const rpc = new Rpc(CHAINS[range.chain].archiveRpcs);
    await pool(todo, 6, async (block) => {
      const results = await multicall(rpc, block, indexCalls(range.chain, assets));
      appendLine(indexRaw(range), decodeIndexCalls(block, results, assets));
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await fetchIndexes(process.argv[2] as ChainKey | undefined);
