// Member portfolios: a full read at the period start, re-reads on a time grid for members that
// acted, and a full read at the block before a first liquidation. Each row also carries the
// reserve indexes and the block time, so balances can be scaled and placed in time exactly.
import { parseAbi } from 'viem';
import { CALM_ID, CHAINS, REREAD_GRID_BLOCKS, type ChainKey } from '../config.ts';
import { readPositions } from '../data.ts';
import { pool, Rpc } from '../rpc.ts';
import { MULTICALL3_ABI, POOL_ABI } from './abis.ts';
import { marketsFor, readActions, type Action } from './actions.ts';
import type { BlockRange } from './blocks.ts';
import { allRanges } from './borrowers.ts';
import { readStart } from './members.ts';
import { multicall, MULTICALL3, type Call } from './multicall.ts';
import { appendLine, eachLine, rawFile } from './store.ts';

const USER_RESERVE_ABI = parseAbi([
  'function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)',
]);

/** At most this many sub-calls in one eth_call. */
const MAX_SUBCALLS = 240;

export type ReadKind = 'start' | 'grid' | 'preliq';

export interface PlannedRead {
  user: string;
  kind: ReadKind;
  /** Every reserve, or only those the member touched since its last read. */
  full: boolean;
  reserves: string[];
  /** The state read applies from this block and time: the member's last action before the read. */
  applyBlock: number;
  applyT: number;
}

export interface UserRead extends PlannedRead {
  emode: number;
  /** getUserAccountData: total collateral and debt (8-decimal USD), threshold (bps), HF (1e18), as strings. */
  account: [collateral: string, debt: string, threshold: number, hf: string];
  /** asset, aToken balance, variable debt, stable debt (token units), used as collateral. */
  balances: Array<[asset: string, supplied: string, variableDebt: string, stableDebt: string, collateral: boolean]>;
}

export interface ReadRow {
  block: number;
  t: number;
  /** asset, normalized income, normalized variable debt (ray), for every reserve read in this row. */
  indexes: Array<[asset: string, income: string, debt: string]>;
  users: UserRead[];
}

const readsRaw = (range: BlockRange): string => rawFile('population', `reads-${range.chain}-${range.window}.jsonl`);

export async function readReads(range: BlockRange): Promise<ReadRow[]> {
  const rows: ReadRow[] = [];
  for await (const row of eachLine<ReadRow>(readsRaw(range))) rows.push(row);
  return rows.sort((a, b) => a.block - b.block);
}

/** First USDC borrow in the period by each account that held no USDC debt at its start. */
export function newcomers(range: BlockRange, actions: Action[], startMembers: Set<string>): Map<string, Action> {
  const usdc = CHAINS[range.chain].usdc.toLowerCase();
  const first = new Map<string, Action>();
  for (const action of actions) {
    if (action.kind !== 'borrow' || action.reserves[0] !== usdc || startMembers.has(action.user) || action.block <= range.fromBlock) continue;
    const known = first.get(action.user);
    if (!known || action.block < known.block || (action.block === known.block && action.logIndex < known.logIndex)) first.set(action.user, action);
  }
  return first;
}

/**
 * Grid re-reads. An action in (g - step, g] is re-read at grid block g, and the state read there
 * applies from that member's last action in the interval. A newcomer's first read is full.
 * Pure, so a test can check it.
 */
export function planGrid(range: BlockRange, actions: Action[], startMembers: Set<string>, joined: Map<string, Action>, step: number): Map<number, PlannedRead[]> {
  const sorted = [...actions].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  const plan = new Map<number, Map<string, PlannedRead>>();
  const readOnce = new Set<string>();
  for (const action of sorted) {
    if (action.block <= range.fromBlock) continue;
    const joinedAt = joined.get(action.user);
    if (!startMembers.has(action.user)) {
      if (!joinedAt) continue;
      if (action.block < joinedAt.block || (action.block === joinedAt.block && action.logIndex < joinedAt.logIndex)) continue;
    }
    const k = Math.ceil((action.block - range.fromBlock) / step);
    const grid = Math.min(range.fromBlock + k * step, range.toBlock);
    const atGrid = plan.get(grid) ?? new Map<string, PlannedRead>();
    plan.set(grid, atGrid);
    let read = atGrid.get(action.user);
    if (!read) {
      const full = !startMembers.has(action.user) && !readOnce.has(action.user);
      readOnce.add(action.user);
      read = { user: action.user, kind: 'grid', full, reserves: [], applyBlock: action.block, applyT: action.t };
      atGrid.set(action.user, read);
    }
    for (const reserve of action.reserves) if (!read.reserves.includes(reserve)) read.reserves.push(reserve);
    read.applyBlock = action.block;
    read.applyT = action.t;
  }
  return new Map([...plan.entries()].sort(([a], [b]) => a - b).map(([block, users]) => [block, [...users.values()]]));
}

/** Members in the headline set already have a portfolio at the block before their liquidation. */
function headlineIds(): Set<string> {
  return new Set(readPositions().filter((p) => p.scope !== 'no_usdc_debt').map((p) => p.id));
}

export interface Plan {
  range: BlockRange;
  assets: string[];
  startMembers: Set<string>;
  joined: Map<string, Action>;
  reads: Map<number, PlannedRead[]>;
}

export async function planRange(range: BlockRange, inHeadline: Set<string>): Promise<Plan> {
  const assets = marketsFor(range).find((m) => m.block === range.fromBlock)!.reserves.map((r) => r.asset);
  const start = await readStart(range);
  const startMembers = new Set(start.balances.keys());
  const actions = readActions(range);
  const joined = newcomers(range, actions, startMembers);
  const step = REREAD_GRID_BLOCKS[range.chain][range.window === CALM_ID ? 'calm' : 'crash'];
  const reads = planGrid(range, actions, startMembers, joined, step);
  reads.set(range.fromBlock, [...startMembers].sort().map((user) => ({ user, kind: 'start', full: true, reserves: [], applyBlock: range.fromBlock, applyT: range.fromTimestamp })));

  // A full read at the block before each tracked member's first liquidation.
  const firstLiquidation = new Map<string, Action>();
  for (const action of actions) {
    if (action.kind !== 'liquidation') continue;
    const tracked = startMembers.has(action.user) || (joined.has(action.user) && action.block > joined.get(action.user)!.block);
    if (!tracked || action.block <= range.fromBlock) continue;
    const known = firstLiquidation.get(action.user);
    if (!known || action.block < known.block) firstLiquidation.set(action.user, action);
  }
  for (const [user, action] of firstLiquidation) {
    if (inHeadline.has(`${range.chain}:${range.window}:${user}`)) continue;
    const block = action.block - 1;
    const list = reads.get(block) ?? [];
    list.push({ user, kind: 'preliq', full: true, reserves: [], applyBlock: block, applyT: NaN });
    reads.set(block, list);
  }
  return { range, assets, startMembers, joined, reads };
}

function userCalls(chain: ChainKey, dataProvider: string, read: PlannedRead, assets: string[]): Call[] {
  const target = CHAINS[chain].pool;
  return [
    { target, abi: POOL_ABI, functionName: 'getUserEMode', args: [read.user] },
    { target, abi: POOL_ABI, functionName: 'getUserAccountData', args: [read.user] },
    ...(read.full ? assets : read.reserves).map((asset) => ({ target: dataProvider, abi: USER_RESERVE_ABI, functionName: 'getUserReserveData', args: [asset, read.user] })),
  ];
}

async function readChunk(rpc: Rpc, range: BlockRange, dataProvider: string, assets: string[], block: number, chunk: PlannedRead[]): Promise<ReadRow> {
  const reserves = [...new Set(chunk.flatMap((r) => (r.full ? assets : r.reserves)))].sort();
  const target = CHAINS[range.chain].pool;
  const calls: Call[] = [
    { target: MULTICALL3, abi: MULTICALL3_ABI, functionName: 'getCurrentBlockTimestamp' },
    ...reserves.flatMap((asset) => [
      { target, abi: POOL_ABI, functionName: 'getReserveNormalizedIncome', args: [asset] },
      { target, abi: POOL_ABI, functionName: 'getReserveNormalizedVariableDebt', args: [asset] },
    ]),
  ];
  const offsets: number[] = [];
  for (const read of chunk) {
    offsets.push(calls.length);
    calls.push(...userCalls(range.chain, dataProvider, read, assets));
  }
  const results = await multicall(rpc, block, calls);
  const t = Number(results[0] as bigint);
  const indexes: ReadRow['indexes'] = reserves.map((asset, i) => {
    const income = results[1 + i * 2] as bigint | null;
    const debt = results[2 + i * 2] as bigint | null;
    if (income === null || debt === null) throw new Error(`no index for ${asset} at ${block}`);
    return [asset, income.toString(), debt.toString()];
  });
  const users = chunk.map((read, j): UserRead => {
    const at = offsets[j]!;
    const emode = results[at] as bigint | null;
    const account = results[at + 1] as readonly bigint[] | null;
    if (emode === null || account === null) throw new Error(`no account for ${read.user} at ${block}`);
    const balances: UserRead['balances'] = [];
    (read.full ? assets : read.reserves).forEach((asset, i) => {
      const row = results[at + 2 + i] as readonly unknown[] | null;
      if (row === null) throw new Error(`no reserve data for ${read.user} ${asset} at ${block}`);
      const supplied = row[0] as bigint;
      const stable = row[1] as bigint;
      const variable = row[2] as bigint;
      // A full read keeps only non-zero reserves. A partial read keeps every reserve it asked
      // for, since a zero there is news.
      if (!read.full || supplied > 0n || stable > 0n || variable > 0n) balances.push([asset, supplied.toString(), variable.toString(), stable.toString(), row[8] as boolean]);
    });
    return {
      ...read,
      applyT: read.kind === 'preliq' || read.kind === 'start' ? t : read.applyT,
      emode: Number(emode),
      account: [account[0]!.toString(), account[1]!.toString(), Number(account[3]), account[5]!.toString()],
      balances,
    };
  });
  return { block, t, indexes, users };
}

export async function fetchPortfolios(options: { only?: ChainKey; planOnly?: boolean } = {}): Promise<void> {
  const inHeadline = headlineIds();
  for (const range of allRanges()) {
    if (options.only && range.chain !== options.only) continue;
    const plan = await planRange(range, inHeadline);
    const market = marketsFor(range).find((m) => m.block === range.fromBlock)!;
    const done = new Set<string>();
    for (const row of await readReads(range)) for (const user of row.users) done.add(`${row.block}:${user.user}:${user.kind}`);

    const jobs: Array<{ block: number; chunk: PlannedRead[] }> = [];
    let pairs = 0;
    for (const [block, reads] of plan.reads) {
      const todo = reads.filter((r) => !done.has(`${block}:${r.user}:${r.kind}`));
      // A chunk costs one timestamp, two index reads per reserve it touches, and per member
      // two account reads plus one per reserve.
      let chunk: PlannedRead[] = [];
      let reserves = new Set<string>();
      let userCost = 0;
      for (const read of todo) {
        const wanted = read.full ? plan.assets : read.reserves;
        const union = new Set([...reserves, ...wanted]);
        const cost = 1 + 2 * union.size + userCost + 2 + wanted.length;
        if (chunk.length > 0 && cost > MAX_SUBCALLS) {
          jobs.push({ block, chunk });
          chunk = [];
          reserves = new Set(wanted);
          userCost = 2 + wanted.length;
        } else {
          reserves = union;
          userCost += 2 + wanted.length;
        }
        chunk.push(read);
        pairs++;
      }
      if (chunk.length > 0) jobs.push({ block, chunk });
    }
    const preliq = [...plan.reads.values()].flat().filter((r) => r.kind === 'preliq').length;
    console.log(
      `${range.chain} ${range.window}: ${plan.startMembers.size} start members, ${plan.joined.size} newcomers, ${plan.reads.size} read blocks, ${preliq} pre-liquidation reads; ${pairs} reads to do in ${jobs.length} calls`,
    );
    if (options.planOnly) continue;
    const rpc = new Rpc(CHAINS[range.chain].archiveRpcs);
    let finished = 0;
    await pool(jobs, 10, async ({ block, chunk }) => {
      appendLine(readsRaw(range), await readChunk(rpc, range, market.dataProvider, plan.assets, block, chunk));
      if (++finished % 1000 === 0) console.log(`${range.chain} ${range.window}: ${finished}/${jobs.length}`);
    });
    console.log(`${range.chain} ${range.window}: ${JSON.stringify(rpc.stats())}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await fetchPortfolios({ only: process.argv[2] as ChainKey | undefined, planOnly: process.argv.includes('--plan') });
}
