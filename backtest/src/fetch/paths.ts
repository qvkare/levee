// Step 2e: the observed path to liquidation, from getUserAccountData at archive blocks.
//
// HF only moves at an oracle update or a user action, so sampling follows the oracle:
//   coarse: every position, every 15 minutes, from the window start to the first liquidation.
//   fine: every update of the feeds behind the position's own assets, in the run-up.
// The run-up starts at the last coarse point with HF at or above FINE_CEILING, and no more
// than FINE_LOOKBACK_SEC before the liquidation. Earlier dips stay at 15-minute resolution.
import { CHAINS, type ChainKey } from '../config.ts';
import { readJson } from '../paths.ts';
import { pool, Rpc } from '../rpc.ts';
import { classify } from '../scope.ts';
import { POOL_ABI } from './abis.ts';
import { BLOCKS_FILE, type BlockRange } from './blocks.ts';
import { multicall } from './multicall.ts';
import { readOracleUpdates } from './oracle.ts';
import { loadPositions, type PositionKey } from './positions.ts';
import { MARKETS_FILE, type MarketSnapshot } from './reserves.ts';
import { marketAt, readSnapshots, type Snapshot } from './snapshots.ts';
import { appendLine, eachLine, rawFile } from './store.ts';

export const COARSE_STEP_SEC = 15 * 60;
export const FINE_LOOKBACK_SEC = 2 * 60 * 60;
/** Above every trigger in the grid, with margin. */
export const FINE_CEILING = 1.4;
const USERS_PER_CALL = 150;

/** block, then rows of: user index, collateral, debt, threshold (all as on chain), HF. */
export type PathRow = [block: number, rows: Array<[user: number, collateral: number, debt: number, threshold: number, hf: number | null]>];

export const pathFile = (chain: ChainKey, window: string): string => rawFile('paths', `${chain}-${window}.jsonl`);

export interface Sample {
  block: number;
  collateral: number;
  debt: number;
  threshold: number;
  hf: number | null;
}

/** Everything fetched so far, by user index, then ascending block. */
export async function readPaths(chain: ChainKey, window: string): Promise<Map<number, Sample[]>> {
  const byUser = new Map<number, Sample[]>();
  for await (const [block, rows] of eachLine<PathRow>(pathFile(chain, window))) {
    for (const [user, collateral, debt, threshold, hf] of rows) {
      const list = byUser.get(user) ?? [];
      list.push({ block, collateral, debt, threshold, hf });
      byUser.set(user, list);
    }
  }
  for (const list of byUser.values()) list.sort((a, b) => a.block - b.block);
  return byUser;
}

interface WindowContext {
  range: BlockRange;
  market: MarketSnapshot;
  positions: PositionKey[];
  snapshots: Map<string, Snapshot>;
  /** Sorted users: the index stored in the raw path file. */
  users: string[];
  updates: Array<{ block: number; t: number; aggregator: string }>;
}

export function sortedUsers(positions: PositionKey[], chain: ChainKey, window: string): string[] {
  return positions
    .filter((p) => p.chain === chain && p.window === window)
    .map((p) => p.user)
    .sort();
}

function coarseBlocks(ctx: WindowContext): Array<{ block: number; t: number }> {
  const { fromBlock, fromTimestamp, toTimestamp } = ctx.range;
  const blocks = [{ block: fromBlock, t: fromTimestamp }];
  let cursor = 0;
  for (let t = fromTimestamp + COARSE_STEP_SEC; t < toTimestamp; t += COARSE_STEP_SEC) {
    while (cursor + 1 < ctx.updates.length && ctx.updates[cursor + 1]!.t <= t) cursor++;
    const update = ctx.updates[cursor]!;
    if (update.block > blocks[blocks.length - 1]!.block) blocks.push({ block: update.block, t: update.t });
  }
  return blocks;
}

async function fetchPlan(rpc: Rpc, chain: ChainKey, window: string, poolAddress: string, plan: Map<number, number[]>, users: string[], label: string): Promise<void> {
  const done = new Set<string>();
  for await (const [block, rows] of eachLine<PathRow>(pathFile(chain, window))) for (const [user] of rows) done.add(`${block}:${user}`);

  const batches: Array<{ block: number; users: number[] }> = [];
  let pairs = 0;
  for (const [block, wanted] of plan) {
    const todo = wanted.filter((user) => !done.has(`${block}:${user}`));
    pairs += todo.length;
    for (let i = 0; i < todo.length; i += USERS_PER_CALL) batches.push({ block, users: todo.slice(i, i + USERS_PER_CALL) });
  }
  console.log(`${chain} ${window} ${label}: ${pairs} reads in ${batches.length} calls over ${plan.size} blocks`);
  let finished = 0;
  await pool(batches, 10, async (batch) => {
    const results = await multicall(
      rpc,
      batch.block,
      batch.users.map((user) => ({ target: poolAddress, abi: POOL_ABI, functionName: 'getUserAccountData', args: [users[user]] })),
    );
    const rows: PathRow[1] = [];
    results.forEach((result, i) => {
      if (!result) return;
      const [collateral, debt, , threshold, , hf] = result as readonly bigint[];
      rows.push([batch.users[i]!, Number(collateral), Number(debt), Number(threshold), hf! > 10n ** 30n ? null : Number(hf! / 10n ** 12n) / 1e6]);
    });
    appendLine(pathFile(chain, window), [batch.block, rows] satisfies PathRow);
    if (++finished % 500 === 0) console.log(`${chain} ${window} ${label}: ${finished}/${batches.length}`);
  });
}

function assetFeeds(market: MarketSnapshot): Map<string, string[]> {
  return new Map(market.reserves.map((r) => [r.asset, r.feeds]));
}

export async function fetchPaths(options: { planOnly?: boolean } = {}): Promise<void> {
  const ranges = readJson<BlockRange[]>(BLOCKS_FILE);
  const markets = readJson<MarketSnapshot[]>(MARKETS_FILE);
  const positions = loadPositions();

  await Promise.all(
    ranges.map(async (range) => {
      const { chain, window } = range;
      const config = CHAINS[chain];
      const market = marketAt(markets, chain, window);
      const snapshots = await readSnapshots(chain, window);
      const updates = readOracleUpdates(chain, window, range).map(({ block, t, aggregator }) => ({ block, t, aggregator }));
      const ctx: WindowContext = {
        range,
        market,
        positions: positions.filter((p) => p.chain === chain && p.window === window),
        snapshots,
        users: sortedUsers(positions, chain, window),
        updates,
      };
      const indexOf = new Map(ctx.users.map((u, i) => [u, i]));
      const inScope = ctx.positions.filter((p) => {
        const snapshot = snapshots.get(p.user);
        return snapshot !== undefined && classify(chain, snapshot.reserves, Number(snapshot.account.debt) / 1e8, 1).scope !== 'no_usdc_debt';
      });
      console.log(`${chain} ${window}: ${inScope.length} of ${ctx.positions.length} positions hold USDC debt`);
      const rpc = new Rpc(config.archiveRpcs);

      // Coarse.
      const coarse = coarseBlocks(ctx);
      const coarsePlan = new Map<number, number[]>();
      for (const { block } of coarse) {
        const list = inScope.filter((p) => block < p.firstBlock).map((p) => indexOf.get(p.user)!);
        if (list.length > 0) coarsePlan.set(block, list);
      }
      if (!options.planOnly) await fetchPlan(rpc, chain, window, config.pool, coarsePlan, ctx.users, 'coarse');

      // Fine, informed by the coarse points just fetched.
      const paths = await readPaths(chain, window);
      const blockTime = new Map(updates.map((u) => [u.block, u.t]));
      const feedsOf = assetFeeds(market);
      const updatesByFeed = new Map<string, Array<{ block: number; t: number }>>();
      for (const update of updates) {
        const list = updatesByFeed.get(update.aggregator) ?? [];
        list.push(update);
        updatesByFeed.set(update.aggregator, list);
      }
      const finePlan = new Map<number, number[]>();
      let pairs = 0;
      for (const position of inScope) {
        const index = indexOf.get(position.user)!;
        const snapshot = snapshots.get(position.user)!;
        const firstBlock = position.firstBlock;
        const firstTime = position.events[0] ? (blockTime.get(firstBlock) ?? approximateTime(updates, firstBlock)) : 0;
        const samples = paths.get(index) ?? [];
        let startTime = firstTime - FINE_LOOKBACK_SEC;
        for (const sample of samples) {
          if (sample.block >= firstBlock) break;
          if (sample.hf === null || sample.hf >= FINE_CEILING) {
            const t = blockTime.get(sample.block) ?? range.fromTimestamp;
            if (t > startTime) startTime = t;
          }
        }
        const feeds = new Set(snapshot.reserves.flatMap(([asset]) => feedsOf.get(asset) ?? []));
        const wanted = new Set<number>([firstBlock - 1]);
        for (const feed of feeds) {
          for (const update of updatesByFeed.get(feed) ?? []) {
            if (update.t >= startTime && update.block < firstBlock) wanted.add(update.block);
          }
        }
        for (const block of wanted) {
          const list = finePlan.get(block) ?? [];
          list.push(index);
          finePlan.set(block, list);
          pairs++;
        }
      }
      console.log(`${chain} ${window}: fine plan ${pairs} reads over ${finePlan.size} blocks`);
      if (!options.planOnly) await fetchPlan(rpc, chain, window, config.pool, finePlan, ctx.users, 'fine');
      console.log(`${chain} ${window}: ${JSON.stringify(rpc.stats())}`);
    }),
  );
}

function approximateTime(updates: Array<{ block: number; t: number }>, block: number): number {
  let low = 0;
  let high = updates.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (updates[mid]!.block < block) low = mid + 1;
    else high = mid;
  }
  return updates[low]!.t;
}

if (import.meta.url === `file://${process.argv[1]}`) await fetchPaths({ planOnly: process.argv.includes('--plan') });
