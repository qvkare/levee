// Step 1: every LiquidationCall on the pinned Pools, inside the pinned block ranges.
// Each chain is fetched from two independent providers and the sets are compared.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { decodeEventLog, parseAbiItem } from 'viem';
import { CHAINS, type ChainKey } from '../config.ts';
import { DERIVED_DIR, writeJson } from '../paths.ts';
import { Rpc } from '../rpc.ts';
import { resolveBlocks } from './blocks.ts';
import { fetchLogs, type RawLog } from './logs.ts';

export const LIQUIDATION_EVENT = parseAbiItem(
  'event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)',
);
export const LIQUIDATION_TOPIC = '0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286';

export interface Liquidation {
  chain: ChainKey;
  window: string;
  block: number;
  txIndex: number;
  logIndex: number;
  tx: string;
  user: string;
  collateralAsset: string;
  debtAsset: string;
  debtToCover: string;
  collateralAmount: string;
  liquidator: string;
  receiveAToken: boolean;
}

export const LIQUIDATIONS_FILE = join(DERIVED_DIR, 'liquidations.json.gz');
export const LIQUIDATIONS_PROVENANCE_FILE = join(DERIVED_DIR, 'liquidations.provenance.json');

const logKey = (log: Pick<RawLog, 'transactionHash' | 'logIndex'>): string => `${log.transactionHash}:${parseInt(log.logIndex, 16)}`;

function decode(chain: ChainKey, window: string, log: RawLog): Liquidation {
  const { args } = decodeEventLog({
    abi: [LIQUIDATION_EVENT],
    data: log.data as `0x${string}`,
    topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
  });
  return {
    chain,
    window,
    block: parseInt(log.blockNumber, 16),
    txIndex: parseInt(log.transactionIndex, 16),
    logIndex: parseInt(log.logIndex, 16),
    tx: log.transactionHash,
    user: args.user.toLowerCase(),
    collateralAsset: args.collateralAsset.toLowerCase(),
    debtAsset: args.debtAsset.toLowerCase(),
    debtToCover: args.debtToCover.toString(),
    collateralAmount: args.liquidatedCollateralAmount.toString(),
    liquidator: args.liquidator.toLowerCase(),
    receiveAToken: args.receiveAToken,
  };
}

export function readLiquidations(): Liquidation[] {
  return JSON.parse(gunzipSync(readFileSync(LIQUIDATIONS_FILE)).toString('utf8')) as Liquidation[];
}

export async function fetchLiquidations(): Promise<Liquidation[]> {
  const ranges = await resolveBlocks();
  const all: Liquidation[] = [];
  const provenance: unknown[] = [];
  for (const range of ranges) {
    const chain = CHAINS[range.chain];
    const perProvider = await Promise.all(
      chain.logRpcs.map(async ({ url, chunk }, i) => {
        const logs = await fetchLogs(new Rpc([url]), {
          name: `${chain.key}/liquidation-p${i}`,
          address: chain.pool,
          topics: [LIQUIDATION_TOPIC],
          fromBlock: range.fromBlock,
          toBlock: range.toBlock,
          chunk,
        });
        return { url, logs };
      }),
    );
    const keys = perProvider.map(({ logs }) => new Set(logs.map(logKey)));
    const union = new Map<string, RawLog>();
    for (const { logs } of perProvider) for (const log of logs) union.set(logKey(log), log);
    // Free providers drop logs without an error. Keep the union, but only after the
    // transaction receipt confirms each log that a provider left out.
    const disputed = [...union.keys()].filter((key) => keys.some((set) => !set.has(key)));
    const receipts = new Rpc(chain.archiveRpcs);
    for (const key of disputed) {
      const log = union.get(key)!;
      const receipt = await receipts.callUntilPresent<{ logs: RawLog[] }>('eth_getTransactionReceipt', [log.transactionHash]);
      if (!receipt.logs.some((l) => logKey({ ...l, transactionHash: log.transactionHash }) === key)) {
        throw new Error(`receipt does not confirm ${key}`);
      }
    }
    const counts = Object.fromEntries(perProvider.map(({ url, logs }) => [new URL(url).host, logs.length]));
    console.log(`${chain.key} ${range.window}: ${JSON.stringify(counts)} union=${union.size} confirmedByReceipt=${disputed.length}`);
    provenance.push({ chain: chain.key, window: range.window, fromBlock: range.fromBlock, toBlock: range.toBlock, counts, union: union.size, confirmedByReceipt: disputed.length });
    for (const log of union.values()) all.push(decode(chain.key, range.window, log));
  }
  all.sort((a, b) => a.chain.localeCompare(b.chain) || a.block - b.block || a.logIndex - b.logIndex);
  writeFileSync(LIQUIDATIONS_FILE, gzipSync(JSON.stringify(all), { level: 9 }));
  writeJson(LIQUIDATIONS_PROVENANCE_FILE, provenance);
  return all;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const all = await fetchLiquidations();
  console.log(`total ${all.length} LiquidationCall events`);
}
