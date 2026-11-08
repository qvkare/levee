// The population at each period start: every candidate's balance of USDC's variable debt token
// at the first block, and the token's totalSupply there. A sum short of totalSupply would mean
// the borrow scan missed someone.
import { CHAINS, type ChainKey } from '../config.ts';
import { pool, Rpc } from '../rpc.ts';
import { ERC20_ABI, POOL_ABI } from './abis.ts';
import type { BlockRange } from './blocks.ts';
import { allRanges, readBorrows } from './borrowers.ts';
import { multicall } from './multicall.ts';
import { appendLine, eachLine, rawFile } from './store.ts';

const BATCH = 400;

/** One batch of balance reads. Only non-zero balances are kept. */
interface BalanceBatch {
  batch: number;
  balances: Array<[user: string, balance: string]>;
}

export interface StartPopulation {
  range: BlockRange;
  debtToken: string;
  totalSupply: bigint;
  candidates: number;
  /** Non-zero USDC variable debt at the first block, in token units. */
  balances: Map<string, bigint>;
}

const membersRaw = (chain: ChainKey, period: string): string => rawFile('population', `members-${chain}-${period}.jsonl`);
const supplyRaw = (chain: ChainKey, period: string): string => rawFile('population', `supply-${chain}-${period}.json.jsonl`);

/** Candidates at a block: every account that borrowed USDC at or before it, sorted. */
export function candidatesAt(chain: ChainKey, block: number): string[] {
  const set = new Set<string>();
  for (const borrow of readBorrows(chain)) if (borrow.block <= block) set.add(borrow.onBehalfOf);
  return [...set].sort();
}

export async function readStart(range: BlockRange): Promise<StartPopulation> {
  const balances = new Map<string, bigint>();
  for await (const batch of eachLine<BalanceBatch>(membersRaw(range.chain, range.window))) {
    for (const [user, balance] of batch.balances) balances.set(user, BigInt(balance));
  }
  let meta: { debtToken: string; totalSupply: string; candidates: number } | null = null;
  for await (const line of eachLine<{ debtToken: string; totalSupply: string; candidates: number }>(supplyRaw(range.chain, range.window))) meta = line;
  if (!meta) throw new Error(`no start population for ${range.chain} ${range.window}`);
  return { range, debtToken: meta.debtToken, totalSupply: BigInt(meta.totalSupply), candidates: meta.candidates, balances };
}

async function fetchRange(range: BlockRange): Promise<void> {
  const config = CHAINS[range.chain];
  const rpc = new Rpc(config.archiveRpcs);
  const candidates = candidatesAt(range.chain, range.fromBlock);
  const [reserve] = (await multicall(rpc, range.fromBlock, [{ target: config.pool, abi: POOL_ABI, functionName: 'getReserveData', args: [config.usdc] }])) as [readonly unknown[]];
  const debtToken = (reserve[10] as string).toLowerCase();

  const done = new Set<number>();
  for await (const batch of eachLine<BalanceBatch>(membersRaw(range.chain, range.window))) done.add(batch.batch);
  const batches: number[] = [];
  for (let i = 0; i * BATCH < candidates.length; i++) if (!done.has(i)) batches.push(i);
  console.log(`${range.chain} ${range.window}: ${candidates.length} candidates, ${batches.length} batches to read`);
  await pool(batches, 6, async (batch) => {
    const users = candidates.slice(batch * BATCH, (batch + 1) * BATCH);
    const results = await multicall(
      rpc,
      range.fromBlock,
      users.map((user) => ({ target: debtToken, abi: ERC20_ABI, functionName: 'balanceOf', args: [user] })),
    );
    const balances: BalanceBatch['balances'] = [];
    results.forEach((result, i) => {
      if (result === null) throw new Error(`balanceOf failed for ${users[i]} at ${range.fromBlock}`);
      if ((result as bigint) > 0n) balances.push([users[i]!, (result as bigint).toString()]);
    });
    appendLine(membersRaw(range.chain, range.window), { batch, balances } satisfies BalanceBatch);
  });
  const [supply] = (await multicall(rpc, range.fromBlock, [{ target: debtToken, abi: ERC20_ABI, functionName: 'totalSupply' }])) as [bigint];
  appendLine(supplyRaw(range.chain, range.window), { debtToken, totalSupply: supply.toString(), candidates: candidates.length });

  const start = await readStart(range);
  let sum = 0n;
  for (const balance of start.balances.values()) sum += balance;
  const gap = Number(start.totalSupply - sum) / Number(start.totalSupply);
  console.log(`${range.chain} ${range.window}: ${start.balances.size} members, sum ${sum} of totalSupply ${start.totalSupply}, gap ${(gap * 100).toFixed(6)}%`);
}

export async function fetchMembers(only?: ChainKey): Promise<void> {
  for (const range of allRanges()) {
    if (only && range.chain !== only) continue;
    await fetchRange(range);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await fetchMembers(process.argv[2] as ChainKey | undefined);
