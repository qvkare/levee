// Every Borrow of native USDC on each pool, from the block USDC was listed to the end of the
// last period. The onBehalfOf addresses are every account that could hold USDC debt at a
// period start. The totalSupply check in members.ts shows whether any were missed.
import { CHAINS, USDC_LISTED_BLOCK, type ChainKey } from '../config.ts';
import { readJson } from '../paths.ts';
import { Rpc } from '../rpc.ts';
import { BLOCKS_FILE, type BlockRange } from './blocks.ts';
import { CALM_FILE, type CalmFile } from './daily.ts';
import { fetchLogs, readLogs } from './logs.ts';

export const BORROW_TOPIC = '0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0';

/** Topic form of an address. */
export const addressTopic = (address: string): string => '0x' + address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
export const topicAddress = (topic: string): string => '0x' + topic.slice(26).toLowerCase();

/** Every window and the calm period, as block ranges. */
export function allRanges(): BlockRange[] {
  return [...readJson<BlockRange[]>(BLOCKS_FILE), ...readJson<CalmFile>(CALM_FILE).ranges];
}

/** Log providers for the long scan. Pocket Network is left out: it drops logs without an error. */
const SCAN_RPCS: Record<ChainKey, { urls: string[]; chunk: number }> = {
  base: { urls: ['https://gateway.tenderly.co/public/base', 'https://base.gateway.tenderly.co', 'https://rpc.sentio.xyz/base'], chunk: 1_000 },
  arbitrum: { urls: ['https://gateway.tenderly.co/public/arbitrum', 'https://arbitrum.gateway.tenderly.co', 'https://arb1.arbitrum.io/rpc'], chunk: 1_000_000 },
};

const logName = (chain: ChainKey): string => `${chain}/borrow-usdc`;

export function scanEnd(chain: ChainKey): number {
  return Math.max(...allRanges().filter((r) => r.chain === chain).map((r) => r.toBlock));
}

export interface BorrowLog {
  block: number;
  onBehalfOf: string;
}

export function readBorrows(chain: ChainKey): BorrowLog[] {
  return readLogs(logName(chain), USDC_LISTED_BLOCK[chain], scanEnd(chain)).map((log) => ({
    block: parseInt(log.blockNumber, 16),
    onBehalfOf: topicAddress(log.topics[2]!),
  }));
}

export async function fetchBorrowers(only?: ChainKey): Promise<void> {
  for (const chain of Object.values(CHAINS)) {
    if (only && chain.key !== only) continue;
    const { urls, chunk } = SCAN_RPCS[chain.key];
    const logs = await fetchLogs(new Rpc(urls), {
      name: logName(chain.key),
      address: chain.pool,
      topics: [BORROW_TOPIC, addressTopic(chain.usdc)],
      fromBlock: USDC_LISTED_BLOCK[chain.key],
      toBlock: scanEnd(chain.key),
      chunk,
      concurrency: chain.key === 'base' ? 12 : 3,
    });
    console.log(`${chain.key}: ${logs.length} USDC borrows, ${new Set(logs.map((l) => l.topics[2])).size} accounts`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await fetchBorrowers(process.argv[2] as ChainKey | undefined);
