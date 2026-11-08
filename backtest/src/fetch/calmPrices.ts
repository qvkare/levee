// The calm period's market snapshot and AaveOracle prices, the same way the windows have them:
// reserves and feeds at both ends, every Chainlink AnswerUpdated in between, and every reserve
// price at each block where a feed updated. Written next to the window files, never into them.
import { join } from 'node:path';
import { CALM_ID, CHAINS, type ChainKey } from '../config.ts';
import { DERIVED_DIR, existsSync, readJson, writeJson } from '../paths.ts';
import { pool, Rpc } from '../rpc.ts';
import { ORACLE_ABI } from './abis.ts';
import { CALM_FILE, type CalmFile } from './daily.ts';
import { fetchLogs } from './logs.ts';
import { multicall } from './multicall.ts';
import { ANSWER_UPDATED_TOPIC, readOracleUpdates } from './oracle.ts';
import { readPrices, type PriceRow } from './prices.ts';
import { snapshot, type MarketSnapshot } from './reserves.ts';
import { appendLine, rawFile } from './store.ts';

export const CALM_MARKETS_FILE = join(DERIVED_DIR, 'portfolio', 'markets-calm.json');

const LOG_RPCS: Record<ChainKey, { urls: string[]; chunk: number }> = {
  base: { urls: ['https://gateway.tenderly.co/public/base', 'https://base.gateway.tenderly.co', 'https://rpc.sentio.xyz/base'], chunk: 1_000 },
  arbitrum: { urls: ['https://gateway.tenderly.co/public/arbitrum', 'https://arbitrum.gateway.tenderly.co'], chunk: 20_000 },
};

export async function fetchCalmMarkets(): Promise<MarketSnapshot[]> {
  if (existsSync(CALM_MARKETS_FILE)) return readJson<MarketSnapshot[]>(CALM_MARKETS_FILE);
  const { ranges } = readJson<CalmFile>(CALM_FILE);
  const out: MarketSnapshot[] = [];
  for (const range of ranges) {
    const rpc = new Rpc(CHAINS[range.chain].archiveRpcs);
    for (const block of [range.fromBlock, range.toBlock]) {
      const snap = await snapshot(rpc, range.chain, CALM_ID, block);
      console.log(`${range.chain} calm @${block}: ${snap.reserves.length} reserves, ${snap.aggregators.length} aggregators`);
      out.push(snap);
    }
  }
  writeJson(CALM_MARKETS_FILE, out);
  return out;
}

/** Extra blocks that need a price row, such as liquidation blocks. */
export async function fetchCalmPrices(extra: Partial<Record<ChainKey, number[]>> = {}, only?: ChainKey): Promise<void> {
  const markets = await fetchCalmMarkets();
  const { ranges } = readJson<CalmFile>(CALM_FILE);
  await Promise.all(
    ranges.map(async (range) => {
      if (only && range.chain !== only) return;
      const chain = CHAINS[range.chain];
      const atChain = markets.filter((m) => m.chain === range.chain);
      const aggregators = [...new Set(atChain.flatMap((m) => m.aggregators))];
      const { urls, chunk } = LOG_RPCS[range.chain];
      await fetchLogs(new Rpc(urls), {
        name: `${range.chain}/answer-updated-${CALM_ID}`,
        address: aggregators,
        topics: [ANSWER_UPDATED_TOPIC],
        fromBlock: range.fromBlock,
        toBlock: range.toBlock,
        chunk,
        concurrency: 4,
      });
      const updates = readOracleUpdates(range.chain, CALM_ID, range);
      const wanted = new Set<number>([range.fromBlock, range.toBlock, ...updates.map((u) => u.block), ...(extra[range.chain] ?? [])]);
      const known = await readPrices(range.chain, CALM_ID);
      const missing = [...wanted].filter((b) => !known.has(b) && b >= range.fromBlock && b <= range.toBlock).sort((a, b) => a - b);
      console.log(`${range.chain} calm: ${updates.length} oracle updates, ${missing.length} price rows to fetch of ${wanted.size}`);
      // Reserve order is the snapshot at the period start. A listing inside the period would
      // show up as a reserve missing from it, and is checked in derive.
      const market = atChain.find((m) => m.block === range.fromBlock)!;
      const assets = market.reserves.map((r) => r.asset);
      const rpc = new Rpc(chain.archiveRpcs);
      let done = 0;
      await pool(missing, 8, async (block) => {
        const [prices] = (await multicall(rpc, block, [{ target: market.oracle, abi: ORACLE_ABI, functionName: 'getAssetsPrices', args: [assets] }])) as [readonly bigint[] | null];
        if (!prices) throw new Error(`no prices at ${block}`);
        appendLine(rawFile('prices', `${range.chain}-${CALM_ID}.jsonl`), [block, prices.map(Number)] satisfies PriceRow);
        if (++done % 5000 === 0) console.log(`${range.chain} calm: ${done}/${missing.length}`);
      });
    }),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) await fetchCalmPrices({}, process.argv[2] as ChainKey | undefined);
