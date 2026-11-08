// Validation sample: getUserAccountData at seeded member and block pairs, to compare with the
// rebuilt path. 200 random blocks per chain and period; at each, 5 random members and 5 whose
// rebuilt HF there is from 1.0 to 1.4. Runs after derive-portfolio, since the second stratum
// needs the rebuilt paths.
import { CHAINS, type ChainKey } from '../config.ts';
import { readPrices as readWindowPrices } from '../data.ts';
import { readCalmPrices, readPopulation, SAMPLE_FILE, writeGz, type SampleFile } from '../portfolio/data.ts';
import { PeriodModel } from '../portfolio/model.ts';
import { mulberry32 } from '../portfolio/random.ts';
import { pool, Rpc } from '../rpc.ts';
import { MULTICALL3_ABI, POOL_ABI } from './abis.ts';
import { marketsFor } from './actions.ts';
import { allRanges } from './borrowers.ts';
import { multicall, MULTICALL3 } from './multicall.ts';
import { appendLine, eachLine, rawFile } from './store.ts';

export const SAMPLE_SEED = 20261108;
const BLOCKS = 200;
const PER_STRATUM = 5;

interface RawSample {
  block: number;
  t: number;
  reads: Array<[member: number, stratum: number, collateral: string, debt: string, hf: string]>;
}

const sampleRaw = (chain: ChainKey, period: string): string => rawFile('population', `sample-${chain}-${period}.jsonl`);

/** Draws `count` distinct items, or all of them if there are fewer. */
function pick<T>(items: T[], count: number, random: () => number): T[] {
  const pool = [...items];
  const out: T[] = [];
  while (out.length < count && pool.length > 0) out.push(pool.splice(Math.floor(random() * pool.length), 1)[0]!);
  return out;
}

export async function fetchSample(): Promise<void> {
  const windowPrices = readWindowPrices();
  const calmPrices = readCalmPrices();
  const file: SampleFile = { rows: [] };
  for (const range of allRanges()) {
    const population = readPopulation(range.chain, range.window);
    const prices = [...windowPrices, ...calmPrices].find((p) => p.chain === range.chain && p.window === range.window)!;
    const market = marketsFor(range).find((m) => m.block === range.fromBlock)!;
    const model = new PeriodModel(population, prices, market);
    const random = mulberry32(SAMPLE_SEED);
    const raw = sampleRaw(range.chain, range.window);
    const done = new Map<number, RawSample>();
    for await (const row of eachLine<RawSample>(raw)) done.set(row.block, row);

    // Approximate time of a block for choosing the second stratum, from the price rows.
    const times = prices.t.reduce<number[]>((acc, d, i) => (acc.push(i === 0 ? d : acc[i - 1]! + d), acc), []);
    const timeAt = (block: number): number => times[model.rowAt(block)]!;

    const plan: Array<{ block: number; reads: Array<[number, number]> }> = [];
    for (let k = 0; k < BLOCKS; k++) {
      const block = range.fromBlock + 1 + Math.floor(random() * (range.toBlock - range.fromBlock));
      const t = timeAt(block);
      const live: number[] = [];
      const near: number[] = [];
      for (let m = 0; m < population.members.length; m++) {
        const state = model.stateAt(m, block);
        if (!state) continue;
        const liquidation = model.liquidations.get(m);
        if (liquidation && liquidation.block <= block) continue;
        live.push(m);
        const hf = model.hfAt(m, block, t);
        if (hf >= 1 && hf <= 1.4) near.push(m);
      }
      const randomPick = pick(live, PER_STRATUM, random);
      const nearPick = pick(near.filter((m) => !randomPick.includes(m)), PER_STRATUM, random);
      plan.push({ block, reads: [...randomPick.map((m): [number, number] => [m, 0]), ...nearPick.map((m): [number, number] => [m, 1])] });
    }

    const rpc = new Rpc(CHAINS[range.chain].archiveRpcs);
    const todo = plan.filter((p) => !done.has(p.block));
    console.log(`${range.chain} ${range.window}: ${todo.length} sample blocks to read`);
    await pool(todo, 6, async ({ block, reads }) => {
      const results = await multicall(rpc, block, [
        { target: MULTICALL3, abi: MULTICALL3_ABI, functionName: 'getCurrentBlockTimestamp' },
        ...reads.map(([m]) => ({ target: CHAINS[range.chain].pool, abi: POOL_ABI, functionName: 'getUserAccountData', args: [population.members[m]!] })),
      ]);
      const row: RawSample = {
        block,
        t: Number(results[0] as bigint),
        reads: reads.map(([m, stratum], i) => {
          const account = results[1 + i] as readonly bigint[];
          return [m, stratum, account[0]!.toString(), account[1]!.toString(), account[5]!.toString()];
        }),
      };
      appendLine(raw, row);
      done.set(block, row);
    });
    for (const { block } of plan) {
      const row = done.get(block)!;
      file.rows.push({
        chain: range.chain,
        period: range.window,
        block,
        t: row.t,
        reads: row.reads.map(([m, stratum, , debt, hf]) => {
          const big = BigInt(hf);
          return [m, stratum, debt === '0' || big > 10n ** 30n ? -1 : Math.round(Number(big / 10n ** 12n)), Math.round(Number(debt) / 1e6) / 100];
        }),
      });
    }
  }
  writeGz(SAMPLE_FILE, file);
}

if (import.meta.url === `file://${process.argv[1]}`) await fetchSample();

