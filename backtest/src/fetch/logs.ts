// Chunked `eth_getLogs` with one raw cache file per chunk, so an interrupted run resumes
// and a re-run needs no network.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RAW_DIR } from '../paths.ts';
import { pool, RangeTooLargeError, Rpc } from '../rpc.ts';

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  transactionIndex: string;
  logIndex: string;
}

export interface LogQuery {
  /** Directory under data/raw/logs. One provider and one filter per directory. */
  name: string;
  address?: string | string[];
  topics: Array<string | string[] | null>;
  fromBlock: number;
  toBlock: number;
  chunk: number;
  concurrency?: number;
}

const hex = (n: number): string => '0x' + n.toString(16);

async function fetchRange(rpc: Rpc, query: LogQuery, dir: string, from: number, to: number): Promise<void> {
  const file = join(dir, `${from}-${to}.json`);
  try {
    readFileSync(file);
    return;
  } catch {
    // Not cached yet.
  }
  try {
    const logs = await rpc.call<RawLog[]>('eth_getLogs', [
      { ...(query.address ? { address: query.address } : {}), topics: query.topics, fromBlock: hex(from), toBlock: hex(to) },
    ]);
    if (!Array.isArray(logs)) throw new Error(`eth_getLogs returned ${typeof logs}`);
    const slim = logs.map(({ address, topics, data, blockNumber, transactionHash, transactionIndex, logIndex }) => ({
      address,
      topics,
      data,
      blockNumber,
      transactionHash,
      transactionIndex,
      logIndex,
    }));
    writeFileSync(file, JSON.stringify(slim));
  } catch (err) {
    if (err instanceof RangeTooLargeError && to > from) {
      const mid = Math.floor((from + to) / 2);
      await fetchRange(rpc, query, dir, from, mid);
      await fetchRange(rpc, query, dir, mid + 1, to);
      return;
    }
    throw err;
  }
}

/** Fetches any chunk not yet cached, then returns every log in the range, ordered. */
export async function fetchLogs(rpc: Rpc, query: LogQuery): Promise<RawLog[]> {
  const dir = join(RAW_DIR, 'logs', query.name);
  mkdirSync(dir, { recursive: true });
  const ranges: Array<[number, number]> = [];
  for (let from = query.fromBlock; from <= query.toBlock; from += query.chunk) {
    ranges.push([from, Math.min(from + query.chunk - 1, query.toBlock)]);
  }
  await pool(ranges, query.concurrency ?? 4, ([from, to]) => fetchRange(rpc, query, dir, from, to));
  return readLogs(query.name, query.fromBlock, query.toBlock);
}

/** Reads cached chunks that fall inside the range. Never touches the network. */
export function readLogs(name: string, fromBlock: number, toBlock: number): RawLog[] {
  const dir = join(RAW_DIR, 'logs', name);
  const seen = new Map<string, RawLog>();
  for (const file of readdirSync(dir)) {
    const match = /^(\d+)-(\d+)\.json$/.exec(file);
    if (!match) continue;
    const from = Number(match[1]);
    const to = Number(match[2]);
    if (to < fromBlock || from > toBlock) continue;
    for (const log of JSON.parse(readFileSync(join(dir, file), 'utf8')) as RawLog[]) {
      const block = parseInt(log.blockNumber, 16);
      if (block < fromBlock || block > toBlock) continue;
      seen.set(`${log.transactionHash}:${log.logIndex}`, log);
    }
  }
  return [...seen.values()].sort(
    (a, b) => parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16) || parseInt(a.logIndex, 16) - parseInt(b.logIndex, 16),
  );
}
