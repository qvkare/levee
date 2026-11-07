// Step 2c: each position just before its first liquidation: account totals from
// getUserAccountData, plus every reserve balance from the data provider.
import { parseAbi } from 'viem';
import { CHAINS, type ChainKey } from '../config.ts';
import { readJson } from '../paths.ts';
import { pool, Rpc } from '../rpc.ts';
import { POOL_ABI } from './abis.ts';
import { multicall, type Call } from './multicall.ts';
import { loadPositions, type PositionKey } from './positions.ts';
import { MARKETS_FILE, type MarketSnapshot } from './reserves.ts';
import { appendLine, eachLine, rawFile } from './store.ts';

const USER_RESERVE_ABI = parseAbi([
  'function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)',
]);

export interface Snapshot {
  chain: ChainKey;
  window: string;
  user: string;
  block: number;
  /** getUserAccountData at `block`, as decimal strings. */
  account: { collateral: string; debt: string; threshold: number; healthFactor: string };
  emode: number;
  /** Non-zero reserves only: asset, aToken balance, variable debt, used as collateral. */
  reserves: Array<[asset: string, supplied: string, debt: string, collateral: boolean]>;
}

const snapshotFile = (chain: ChainKey, window: string): string => rawFile('snapshots', `${chain}-${window}.jsonl`);

export async function readSnapshots(chain: ChainKey, window: string): Promise<Map<string, Snapshot>> {
  const snapshots = new Map<string, Snapshot>();
  for await (const snapshot of eachLine<Snapshot>(snapshotFile(chain, window))) snapshots.set(snapshot.user, snapshot);
  return snapshots;
}

export function marketAt(markets: MarketSnapshot[], chain: ChainKey, window: string): MarketSnapshot {
  const market = markets.find((m) => m.chain === chain && m.window === window);
  if (!market) throw new Error(`no market for ${chain} ${window}`);
  return market;
}

/** Users at one block, chunked so a single eth_call stays small. */
function batches(positions: PositionKey[], size: number): PositionKey[][] {
  const byBlock = new Map<number, PositionKey[]>();
  for (const position of positions) {
    const list = byBlock.get(position.firstBlock) ?? [];
    list.push(position);
    byBlock.set(position.firstBlock, list);
  }
  const out: PositionKey[][] = [];
  for (const list of byBlock.values()) {
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  }
  return out;
}

export async function fetchSnapshots(): Promise<void> {
  const markets = readJson<MarketSnapshot[]>(MARKETS_FILE);
  const positions = loadPositions();
  for (const chain of Object.values(CHAINS)) {
    const rpc = new Rpc(chain.archiveRpcs);
    for (const window of new Set(positions.map((p) => p.window))) {
      const market = marketAt(markets, chain.key, window);
      const assets = market.reserves.map((r) => r.asset);
      const done = await readSnapshots(chain.key, window);
      const todo = positions.filter((p) => p.chain === chain.key && p.window === window && !done.has(p.user));
      console.log(`${chain.key} ${window}: ${todo.length} snapshots to fetch`);
      await pool(batches(todo, 6), 8, async (batch) => {
        const block = batch[0]!.firstBlock - 1;
        const calls: Call[] = batch.flatMap((p) => [
          { target: chain.pool, abi: POOL_ABI, functionName: 'getUserAccountData', args: [p.user] },
          { target: chain.pool, abi: POOL_ABI, functionName: 'getUserEMode', args: [p.user] },
          ...assets.map((asset) => ({ target: market.dataProvider, abi: USER_RESERVE_ABI, functionName: 'getUserReserveData', args: [asset, p.user] })),
        ]);
        const results = await multicall(rpc, block, calls);
        const stride = 2 + assets.length;
        batch.forEach((p, i) => {
          const row = results.slice(i * stride, (i + 1) * stride);
          const account = row[0] as readonly bigint[] | null;
          const emode = row[1] as bigint | null;
          if (!account) throw new Error(`no account data for ${p.user} at ${block}`);
          const reserves: Snapshot['reserves'] = [];
          assets.forEach((asset, j) => {
            const reserve = row[2 + j] as readonly unknown[] | null;
            if (!reserve) throw new Error(`no reserve data for ${p.user} ${asset} at ${block}`);
            const supplied = reserve[0] as bigint;
            const debt = (reserve[1] as bigint) + (reserve[2] as bigint);
            if (supplied > 0n || debt > 0n) reserves.push([asset, supplied.toString(), debt.toString(), reserve[8] as boolean]);
          });
          const snapshot: Snapshot = {
            chain: chain.key,
            window,
            user: p.user,
            block,
            account: {
              collateral: account[0]!.toString(),
              debt: account[1]!.toString(),
              threshold: Number(account[3]),
              healthFactor: account[5]!.toString(),
            },
            emode: Number(emode ?? 0n),
            reserves,
          };
          appendLine(snapshotFile(chain.key, window), snapshot);
        });
      });
    }
    console.log(JSON.stringify(rpc.stats()));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await fetchSnapshots();
