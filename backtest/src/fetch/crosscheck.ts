// Re-reads a sample of stored archive reads on every provider of the chain and counts any
// difference. One free provider already dropped logs without an error, so nothing here is
// taken on trust from a single source.
import { join } from 'node:path';
import { CHAINS, type ChainKey } from '../config.ts';
import { DERIVED_DIR, readJson, writeJson } from '../paths.ts';
import { Rpc, sleep } from '../rpc.ts';
import { POOL_ABI } from './abis.ts';
import { BLOCKS_FILE, type BlockRange } from './blocks.ts';
import { multicall } from './multicall.ts';
import { pathFile, sortedUsers, type PathRow } from './paths.ts';
import { loadPositions } from './positions.ts';
import { eachLine } from './store.ts';

const SAMPLE_ROWS_PER_WINDOW = 40;

/** Deterministic pick, so a re-run checks the same reads. */
function sample<T>(items: T[], count: number): T[] {
  const step = Math.max(1, Math.floor(items.length / count));
  return items.filter((_, i) => i % step === 0).slice(0, count);
}

export async function crossCheck(): Promise<void> {
  const ranges = readJson<BlockRange[]>(BLOCKS_FILE);
  const positions = loadPositions();
  let reads = 0;
  let mismatches = 0;
  let failedProviders = 0;
  const hosts = new Set<string>();
  for (const range of ranges) {
    const { chain, window } = range as { chain: ChainKey; window: string };
    const config = CHAINS[chain];
    const users = sortedUsers(positions, chain, window);
    const rows: PathRow[] = [];
    for await (const row of eachLine<PathRow>(pathFile(chain, window))) rows.push(row);
    for (const [block, stored] of sample(rows, SAMPLE_ROWS_PER_WINDOW)) {
      for (const url of config.archiveRpcs) {
        const rpc = new Rpc([url], { maxAttempts: 4 });
        let results: unknown[];
        try {
          results = await multicall(
            rpc,
            block,
            stored.map(([user]) => ({ target: config.pool, abi: POOL_ABI, functionName: 'getUserAccountData', args: [users[user]] })),
          );
        } catch {
          failedProviders++;
          continue;
        }
        hosts.add(new URL(url).host);
        stored.forEach(([, collateral, debt, threshold], i) => {
          const result = results[i] as readonly bigint[] | null;
          reads++;
          if (!result || Number(result[0]) !== collateral || Number(result[1]) !== debt || Number(result[3]) !== threshold) mismatches++;
        });
        await sleep(100);
      }
    }
    console.log(`${chain} ${window}: ${reads} reads so far, ${mismatches} mismatches`);
  }
  writeJson(join(DERIVED_DIR, 'crosscheck.json'), { reads, mismatches, providers: [...hosts].sort(), providerCallsThatFailed: failedProviders });
}

if (import.meta.url === `file://${process.argv[1]}`) await crossCheck();
