// Daily reads from 2025-01-01 to 2026-11-01: the AaveOracle WETH price on Base, which picks the
// calm period, and the USDC borrow and supply rates on both pools, which give the carry.
// Then pins the calm period to block ranges on both chains.
import { join } from 'node:path';
import { BASE_WETH, baseBlockAt, CALM_ID, CALM_RULE, CHAINS, toUnix, type ChainKey } from '../config.ts';
import { chooseCalm, type CalmChoice } from '../calm.ts';
import { DERIVED_DIR, readJson, writeJson } from '../paths.ts';
import { pool, Rpc } from '../rpc.ts';
import { MULTICALL3_ABI, ORACLE_ABI, POOL_ABI, PROVIDER_ABI } from './abis.ts';
import { firstBlockAtOrAfter, timestampOf, type BlockRange } from './blocks.ts';
import { multicall, MULTICALL3 } from './multicall.ts';
import { MARKETS_FILE, type MarketSnapshot } from './reserves.ts';
import { appendLine, eachLine, rawFile } from './store.ts';

export const DAILY_FILE = join(DERIVED_DIR, 'daily.json');
export const CALM_FILE = join(DERIVED_DIR, 'calm.json');

/** One daily read. Rates are APRs. `weth` is the 8-decimal oracle price, Base only. */
export interface DailyRow {
  block: number;
  t: number;
  borrowApr: number;
  supplyApr: number;
  weth?: number;
}

export interface CalmFile {
  rule: typeof CALM_RULE;
  choice: CalmChoice;
  ranges: BlockRange[];
}

const RAY = 1e27;
const DAY = 86_400;
const dailyRaw = (chain: ChainKey): string => rawFile('daily', `${chain}.jsonl`);

function midnights(): number[] {
  const out: number[] = [];
  for (let t = toUnix(CALM_RULE.fromIso); t <= toUnix(CALM_RULE.toIso); t += DAY) out.push(t);
  return out;
}

async function readRows(chain: ChainKey): Promise<Map<number, DailyRow>> {
  const rows = new Map<number, DailyRow>();
  for await (const row of eachLine<DailyRow>(dailyRaw(chain))) rows.set(row.block, row);
  return rows;
}

async function fetchChain(chain: ChainKey, blocks: number[], provider: string, readWeth: boolean): Promise<void> {
  const config = CHAINS[chain];
  const rpc = new Rpc(config.archiveRpcs);
  const known = await readRows(chain);
  const todo = blocks.filter((b) => !known.has(b));
  console.log(`${chain}: ${todo.length} daily reads`);
  await pool(todo, 6, async (block) => {
    const calls = [
      { target: MULTICALL3, abi: MULTICALL3_ABI, functionName: 'getCurrentBlockTimestamp' },
      { target: config.pool, abi: POOL_ABI, functionName: 'getReserveData', args: [config.usdc] },
      { target: provider, abi: PROVIDER_ABI, functionName: 'getPriceOracle' },
    ];
    const [t, reserve, current] = (await multicall(rpc, block, calls)) as [bigint, readonly unknown[], string];
    const row: DailyRow = { block, t: Number(t), borrowApr: Number(reserve[4] as bigint) / RAY, supplyApr: Number(reserve[2] as bigint) / RAY };
    if (readWeth) {
      // The oracle address is read on the same block, so a migration cannot slip through.
      const [price] = (await multicall(rpc, block, [{ target: current, abi: ORACLE_ABI, functionName: 'getAssetPrice', args: [BASE_WETH] }])) as [bigint];
      row.weth = Number(price);
    }
    appendLine(dailyRaw(chain), row);
  });
}

export async function fetchDaily(): Promise<void> {
  const markets = readJson<MarketSnapshot[]>(MARKETS_FILE);
  const providerOf = (chain: ChainKey): string => markets.find((m) => m.chain === chain)!.provider;
  const times = midnights();

  // Base: the block at or after each midnight follows from the time.
  await fetchChain('base', times.map(baseBlockAt), providerOf('base'), true);

  // Arbitrum has no fixed block time: pin both ends, then space reads evenly by block.
  const arbitrum = new Rpc(CHAINS.arbitrum.archiveRpcs);
  const head = parseInt(await arbitrum.call<string>('eth_blockNumber', []), 16);
  const first = await firstBlockAtOrAfter(arbitrum, times[0]!, head);
  const last = await firstBlockAtOrAfter(arbitrum, times[times.length - 1]!, head);
  const steps = times.length - 1;
  const arbBlocks = times.map((_, i) => first + Math.round(((last - first) * i) / steps));
  await fetchChain('arbitrum', arbBlocks, providerOf('arbitrum'), false);

  const daily: Record<ChainKey, DailyRow[]> = { base: [], arbitrum: [] };
  for (const chain of ['base', 'arbitrum'] as const) {
    const rows = await readRows(chain);
    const wanted = chain === 'base' ? times.map(baseBlockAt) : arbBlocks;
    daily[chain] = wanted.map((block) => {
      const row = rows.get(block);
      if (!row) throw new Error(`missing daily read ${chain} ${block}`);
      return row;
    });
  }
  const round = (x: number): number => Math.round(x * 1e8) / 1e8;
  writeJson(
    DAILY_FILE,
    Object.fromEntries(Object.entries(daily).map(([chain, rows]) => [chain, rows.map((r) => ({ ...r, borrowApr: round(r.borrowApr), supplyApr: round(r.supplyApr) }))])),
    false,
  );

  // The rule picks the period from Base WETH prices alone.
  const choice = chooseCalm(
    daily.base.map((row, i) => ({ t: times[i]!, price: row.weth! })),
    CALM_RULE.maxDailyMove,
    CALM_RULE.days,
  );
  console.log(`calm run starts ${new Date(choice.runStartTime * 1000).toISOString()}, ${choice.runDays} days; period ${new Date(choice.startTime * 1000).toISOString()} to ${new Date(choice.endTime * 1000).toISOString()}`);

  const ranges: BlockRange[] = [];
  const baseFrom = baseBlockAt(choice.startTime);
  const baseTo = baseBlockAt(choice.endTime) - 1;
  ranges.push({ chain: 'base', window: CALM_ID, fromBlock: baseFrom, toBlock: baseTo, fromTimestamp: await timestampOf(new Rpc(CHAINS.base.archiveRpcs), baseFrom), toTimestamp: await timestampOf(new Rpc(CHAINS.base.archiveRpcs), baseTo) });
  const arbFrom = await firstBlockAtOrAfter(arbitrum, choice.startTime, head);
  const arbTo = (await firstBlockAtOrAfter(arbitrum, choice.endTime, head)) - 1;
  ranges.push({ chain: 'arbitrum', window: CALM_ID, fromBlock: arbFrom, toBlock: arbTo, fromTimestamp: await timestampOf(arbitrum, arbFrom), toTimestamp: await timestampOf(arbitrum, arbTo) });
  writeJson(CALM_FILE, { rule: CALM_RULE, choice, ranges } satisfies CalmFile);
}

if (import.meta.url === `file://${process.argv[1]}`) await fetchDaily();
