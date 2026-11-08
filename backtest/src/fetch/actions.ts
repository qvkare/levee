// Every action in each period that can change a member's portfolio: the Pool's Supply, Withdraw,
// Borrow, Repay, LiquidationCall, collateral switches, eMode changes and deficits, and every
// aToken BalanceTransfer. One filter covers both, since the Pool and the aTokens emit
// different topics.

import { CALM_ID, CHAINS, type ChainKey } from '../config.ts';
import { readJson } from '../paths.ts';
import { Rpc } from '../rpc.ts';
import type { BlockRange } from './blocks.ts';
import { allRanges, topicAddress } from './borrowers.ts';
import { CALM_MARKETS_FILE } from './calmPrices.ts';
import { fetchLogs, readLogs, type RawLog } from './logs.ts';
import { MARKETS_FILE, type MarketSnapshot } from './reserves.ts';

export const TOPICS = {
  supply: '0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61',
  withdraw: '0x3115d1449a7b732c986cba18244e897a450f61e1bb8d589cd2e69e6c8924f9f7',
  borrow: '0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0',
  repay: '0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051',
  liquidation: '0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286',
  collateralOn: '0x00058a56ea94653cdf4f152d227ace22d4c00ad99e2a43f58cb7d9e3feb295f2',
  collateralOff: '0x44c58d81365b66dd4b1a7f36c25aa97b8c71c361ee4937adc1a00000227db5dd',
  emode: '0xd728da875fc88944cbf17638bcbe4af0eedaef63becd1d1c57cc097eb4608d84',
  deficit: '0x2bccfb3fad376d59d7accf970515eb77b2f27b082c90ed0fb15583dd5a942699',
  balanceTransfer: '0x4beccb90f994c31aced7a23b5611020728a23d8ec5cddd1a3e9d97b96fda8666',
} as const;

const LOG_RPCS: Record<ChainKey, { urls: string[]; chunk: number }> = {
  base: { urls: ['https://gateway.tenderly.co/public/base', 'https://base.gateway.tenderly.co', 'https://rpc.sentio.xyz/base'], chunk: 1_000 },
  arbitrum: { urls: ['https://gateway.tenderly.co/public/arbitrum', 'https://arbitrum.gateway.tenderly.co'], chunk: 20_000 },
};

/** One account touched by one log: which reserves to re-read, and whether eMode changed. */
export interface Action {
  block: number;
  t: number;
  logIndex: number;
  user: string;
  reserves: string[];
  kind: keyof typeof TOPICS;
}

/** Market snapshots for a period: the windows' own, or the calm period's. */
export function marketsFor(range: BlockRange): MarketSnapshot[] {
  const file = range.window === CALM_ID ? CALM_MARKETS_FILE : MARKETS_FILE;
  return readJson<MarketSnapshot[]>(file).filter((m) => m.chain === range.chain && m.window === range.window);
}

const logName = (range: BlockRange): string => `${range.chain}/actions-${range.window}`;

function aTokens(range: BlockRange): Map<string, string> {
  const map = new Map<string, string>();
  for (const market of marketsFor(range)) for (const reserve of market.reserves) map.set(reserve.aToken, reserve.asset);
  return map;
}

export function decodeActions(range: BlockRange, logs: RawLog[]): Action[] {
  const underlying = aTokens(range);
  const kinds = new Map<string, keyof typeof TOPICS>(Object.entries(TOPICS).map(([kind, topic]) => [topic, kind as keyof typeof TOPICS]));
  const out: Action[] = [];
  for (const log of logs) {
    const kind = kinds.get(log.topics[0]!);
    if (!kind) continue;
    const block = parseInt(log.blockNumber, 16);
    const t = log.blockTimestamp ? parseInt(log.blockTimestamp, 16) : NaN;
    const logIndex = parseInt(log.logIndex, 16);
    const push = (user: string, reserves: string[]): void => {
      out.push({ block, t, logIndex, user, reserves, kind });
    };
    const at = (i: number): string => topicAddress(log.topics[i]!);
    switch (kind) {
      case 'supply':
      case 'withdraw':
      case 'borrow':
      case 'repay':
      case 'collateralOn':
      case 'collateralOff':
        push(at(2), [at(1)]);
        break;
      case 'liquidation':
        push(at(3), [at(1), at(2)]);
        break;
      case 'emode':
        push(at(1), []);
        break;
      case 'deficit':
        push(at(1), [at(2)]);
        break;
      case 'balanceTransfer': {
        const asset = underlying.get(log.address.toLowerCase());
        if (!asset) throw new Error(`BalanceTransfer from unknown aToken ${log.address}`);
        push(at(1), [asset]);
        push(at(2), [asset]);
        break;
      }
    }
  }
  return out;
}

export const readActionLogs = (range: BlockRange): RawLog[] => readLogs(logName(range), range.fromBlock, range.toBlock);

export function readActions(range: BlockRange): Action[] {
  return decodeActions(range, readActionLogs(range));
}

export async function fetchActions(only?: ChainKey): Promise<void> {
  for (const range of allRanges()) {
    if (only && range.chain !== only) continue;
    const { urls, chunk } = LOG_RPCS[range.chain];
    const pool = CHAINS[range.chain].pool;
    const logs = await fetchLogs(new Rpc(urls), {
      name: logName(range),
      address: [pool, ...aTokens(range).keys()],
      topics: [Object.values(TOPICS)],
      fromBlock: range.fromBlock,
      toBlock: range.toBlock,
      chunk,
      concurrency: range.chain === 'base' ? 8 : 4,
    });
    const missingTime = logs.filter((l) => !l.blockTimestamp).length;
    console.log(`${range.chain} ${range.window}: ${logs.length} action logs, ${missingTime} without a timestamp`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await fetchActions(process.argv[2] as ChainKey | undefined);

