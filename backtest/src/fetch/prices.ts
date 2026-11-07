// Step 2d: AaveOracle prices for every reserve at every block where a feed updated, and at
// every liquidation block. Prices are the oracle's own output, caps and ratios included.
import { CHAINS, type ChainKey } from '../config.ts';
import { readJson } from '../paths.ts';
import { pool, Rpc } from '../rpc.ts';
import { ORACLE_ABI } from './abis.ts';
import { BLOCKS_FILE, type BlockRange } from './blocks.ts';
import { multicall } from './multicall.ts';
import { readOracleUpdates } from './oracle.ts';
import { loadPositions } from './positions.ts';
import { MARKETS_FILE, type MarketSnapshot } from './reserves.ts';
import { marketAt } from './snapshots.ts';
import { appendLine, eachLine, rawFile } from './store.ts';

/** Block, then one 8-decimal USD price per reserve in market order. */
export type PriceRow = [block: number, prices: number[]];

const priceFile = (chain: ChainKey, window: string): string => rawFile('prices', `${chain}-${window}.jsonl`);

export async function readPrices(chain: ChainKey, window: string): Promise<Map<number, number[]>> {
  const prices = new Map<number, number[]>();
  for await (const [block, row] of eachLine<PriceRow>(priceFile(chain, window))) prices.set(block, row);
  return prices;
}

export async function fetchPrices(): Promise<void> {
  const ranges = readJson<BlockRange[]>(BLOCKS_FILE);
  const markets = readJson<MarketSnapshot[]>(MARKETS_FILE);
  const positions = loadPositions();
  await Promise.all(
    ranges.map(async (range) => {
      const chain = CHAINS[range.chain];
      const market = marketAt(markets, range.chain, range.window);
      const wanted = new Set<number>([range.fromBlock, range.toBlock]);
      for (const update of readOracleUpdates(range.chain, range.window, range)) wanted.add(update.block);
      for (const position of positions) {
        if (position.chain !== range.chain || position.window !== range.window) continue;
        for (const event of position.events) wanted.add(event.block);
      }
      const known = await readPrices(range.chain, range.window);
      const missing = [...wanted].filter((b) => !known.has(b)).sort((a, b) => a - b);
      console.log(`${range.chain} ${range.window}: ${missing.length} price rows to fetch of ${wanted.size}`);
      const rpc = new Rpc(chain.archiveRpcs);
      const assets = market.reserves.map((r) => r.asset);
      let done = 0;
      await pool(missing, 8, async (block) => {
        const [prices] = (await multicall(rpc, block, [
          { target: market.oracle, abi: ORACLE_ABI, functionName: 'getAssetsPrices', args: [assets] },
        ])) as [readonly bigint[] | null];
        if (!prices) throw new Error(`no prices at ${block}`);
        appendLine(priceFile(range.chain, range.window), [block, prices.map(Number)] satisfies PriceRow);
        if (++done % 2000 === 0) console.log(`${range.chain} ${range.window}: ${done}/${missing.length}`);
      });
    }),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) await fetchPrices();
