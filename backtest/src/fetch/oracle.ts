// Step 2b: every Chainlink update behind AaveOracle inside the windows. Health factor only
// moves when a price updates or the user acts, so these blocks are where sampling matters.
import { CHAINS, type ChainKey } from '../config.ts';
import { readJson } from '../paths.ts';
import { Rpc } from '../rpc.ts';
import { BLOCKS_FILE, type BlockRange } from './blocks.ts';
import { fetchLogs, readLogs } from './logs.ts';
import { MARKETS_FILE, type MarketSnapshot } from './reserves.ts';

// keccak256("AnswerUpdated(int256,uint256,uint256)")
export const ANSWER_UPDATED_TOPIC = '0x0559884fd3a460db3073b7fc896cc77986f16e378210ded43186175bf646fc5f';

export interface OracleUpdate {
  block: number;
  /** block.timestamp as reported by the aggregator. */
  t: number;
  aggregator: string;
  answer: bigint;
}

const logName = (chain: ChainKey, window: string): string => `${chain}/answer-updated-${window}`;

function decode(raw: ReturnType<typeof readLogs>[number]): OracleUpdate {
  return {
    block: parseInt(raw.blockNumber, 16),
    t: Number(BigInt(raw.data)),
    aggregator: raw.address.toLowerCase(),
    answer: BigInt(raw.topics[1]!),
  };
}

export function readOracleUpdates(chain: ChainKey, window: string, range: BlockRange): OracleUpdate[] {
  return readLogs(logName(chain, window), range.fromBlock, range.toBlock).map(decode);
}

export async function fetchOracleUpdates(): Promise<void> {
  const ranges = readJson<BlockRange[]>(BLOCKS_FILE);
  const markets = readJson<MarketSnapshot[]>(MARKETS_FILE);
  await Promise.all(
    ranges.map(async (range) => {
      const chain = CHAINS[range.chain];
      const aggregators = [...new Set(markets.filter((m) => m.chain === range.chain && m.window === range.window).flatMap((m) => m.aggregators))];
      const { url, chunk } = chain.logRpcs[0]!;
      const logs = await fetchLogs(new Rpc([url]), {
        name: logName(range.chain, range.window),
        address: aggregators,
        topics: [ANSWER_UPDATED_TOPIC],
        fromBlock: range.fromBlock,
        toBlock: range.toBlock,
        chunk,
        concurrency: 3,
      });
      console.log(`${range.chain} ${range.window}: ${logs.length} updates in ${new Set(logs.map((l) => l.blockNumber)).size} blocks`);
    }),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) await fetchOracleUpdates();
