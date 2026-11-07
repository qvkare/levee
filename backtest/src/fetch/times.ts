// Exact timestamps for the liquidation blocks and the blocks just before them.
import { CHAINS, type ChainKey } from '../config.ts';
import { pool, Rpc } from '../rpc.ts';
import { loadPositions } from './positions.ts';
import { appendLine, eachLine, rawFile } from './store.ts';

const timesFile = (chain: ChainKey): string => rawFile('times', `${chain}.jsonl`);

export async function readTimes(chain: ChainKey): Promise<Map<number, number>> {
  const times = new Map<number, number>();
  for await (const [block, t] of eachLine<[number, number]>(timesFile(chain))) times.set(block, t);
  return times;
}

export async function fetchTimes(): Promise<void> {
  const positions = loadPositions();
  for (const chain of Object.values(CHAINS)) {
    const wanted = new Set<number>();
    for (const position of positions) {
      if (position.chain !== chain.key) continue;
      for (const event of position.events) {
        wanted.add(event.block);
        wanted.add(event.block - 1);
      }
    }
    const known = await readTimes(chain.key);
    const missing = [...wanted].filter((b) => !known.has(b)).sort((a, b) => a - b);
    console.log(`${chain.key}: ${missing.length} block timestamps to fetch`);
    const rpc = new Rpc(chain.archiveRpcs);
    await pool(missing, 8, async (block) => {
      const raw = await rpc.callUntilPresent<{ timestamp: string }>('eth_getBlockByNumber', ['0x' + block.toString(16), false]);
      appendLine(timesFile(chain.key), [block, parseInt(raw.timestamp, 16)]);
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await fetchTimes();
