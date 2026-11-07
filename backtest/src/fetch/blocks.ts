// Resolves each window to a pinned block range by binary search on block timestamps.
import { join } from 'node:path';
import { CHAINS, WINDOWS, toUnix, type ChainKey } from '../config.ts';
import { DERIVED_DIR, existsSync, readJson, writeJson } from '../paths.ts';
import { Rpc } from '../rpc.ts';

export interface BlockRange {
  chain: ChainKey;
  window: string;
  fromBlock: number;
  toBlock: number;
  fromTimestamp: number;
  toTimestamp: number;
}

export const BLOCKS_FILE = join(DERIVED_DIR, 'blocks.json');

interface RawBlock {
  number: string;
  timestamp: string;
}

async function timestampOf(rpc: Rpc, block: number): Promise<number> {
  const raw = await rpc.call<RawBlock | null>('eth_getBlockByNumber', ['0x' + block.toString(16), false]);
  if (!raw) throw new Error(`block ${block} missing`);
  return parseInt(raw.timestamp, 16);
}

/** First block with timestamp >= target. */
async function firstBlockAtOrAfter(rpc: Rpc, target: number, head: number): Promise<number> {
  let low = 0;
  let high = head;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if ((await timestampOf(rpc, mid)) >= target) high = mid;
    else low = mid + 1;
  }
  return low;
}

export async function resolveBlocks(): Promise<BlockRange[]> {
  const known = existsSync(BLOCKS_FILE) ? readJson<BlockRange[]>(BLOCKS_FILE) : [];
  const ranges: BlockRange[] = [];
  for (const chain of Object.values(CHAINS)) {
    const rpc = new Rpc(chain.archiveRpcs);
    const head = parseInt(await rpc.call<string>('eth_blockNumber', []), 16);
    for (const window of WINDOWS) {
      const cached = known.find((r) => r.chain === chain.key && r.window === window.id);
      if (cached) {
        ranges.push(cached);
        continue;
      }
      const start = toUnix(window.startIso);
      const end = toUnix(window.endIso);
      const fromBlock = await firstBlockAtOrAfter(rpc, start, head);
      const toBlock = (await firstBlockAtOrAfter(rpc, end, head)) - 1;
      const range: BlockRange = {
        chain: chain.key,
        window: window.id,
        fromBlock,
        toBlock,
        fromTimestamp: await timestampOf(rpc, fromBlock),
        toTimestamp: await timestampOf(rpc, toBlock),
      };
      console.log(JSON.stringify(range));
      ranges.push(range);
    }
  }
  writeJson(BLOCKS_FILE, ranges);
  return ranges;
}

if (import.meta.url === `file://${process.argv[1]}`) await resolveBlocks();
