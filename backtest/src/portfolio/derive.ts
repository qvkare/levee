// Raw population reads to the compact committed files in data/derived/portfolio. No network.
import { mkdirSync } from 'node:fs';
import { decodeEventLog } from 'viem';
import { CALM_ID, CHAINS, type ChainKey } from '../config.ts';
import { deltaEncode, readPositions, readPrices as readWindowPrices, type WindowPrices } from '../data.ts';
import { compactPrices } from '../derive.ts';
import { PriceBook } from '../frozen.ts';
import { marketsFor, readActionLogs, TOPICS } from '../fetch/actions.ts';
import type { BlockRange } from '../fetch/blocks.ts';
import { allRanges } from '../fetch/borrowers.ts';
import { readIndexes } from '../fetch/indexes.ts';
import { LIQUIDATION_EVENT } from '../fetch/liquidations.ts';
import { readStart } from '../fetch/members.ts';
import { readOracleUpdates } from '../fetch/oracle.ts';
import { planRange, readReads, type UserRead } from '../fetch/portfolios.ts';
import { readPrices as readRawPrices } from '../fetch/prices.ts';
import type { MarketSnapshot, Reserve } from '../fetch/reserves.ts';
import { CALM_PRICES_FILE, INDEX_UNIT, populationFile, PORTFOLIO_DIR, ReadCode, writeGz, type PopulationFile } from './data.ts';

const EPISODE_GAP_SEC = 3600;
const stableSeen = { count: 0 };
const significant = (x: number): number => (x === 0 ? 0 : Number(x.toPrecision(10)));
const RAY = 1e27;

function inCategory(reserve: Reserve, market: MarketSnapshot, emode: number): boolean {
  const category = market.emodes.find((e) => e.id === emode);
  return category !== undefined && (BigInt(category.collateralBitmap) >> BigInt(reserve.id)) % 2n === 1n;
}

/** Calm-period prices, compacted like the windows'. Liquidation blocks get rows too. */
export async function deriveCalmPrices(): Promise<WindowPrices[]> {
  const out: WindowPrices[] = [];
  for (const range of allRanges().filter((r) => r.window === CALM_ID)) {
    const market = marketsFor(range).find((m) => m.block === range.fromBlock)!;
    const rows = await readRawPrices(range.chain, CALM_ID);
    const times = new Map<number, number>([
      [range.fromBlock, range.fromTimestamp],
      [range.toBlock, range.toTimestamp],
    ]);
    for (const update of readOracleUpdates(range.chain, CALM_ID, range)) times.set(update.block, update.t);
    for (const log of readActionLogs(range)) if (log.blockTimestamp) times.set(parseInt(log.blockNumber, 16), parseInt(log.blockTimestamp, 16));
    const inRange = new Map([...rows].filter(([block]) => block >= range.fromBlock && block <= range.toBlock));
    out.push(
      compactPrices(range.chain, CALM_ID, market, inRange, (block) => {
        const t = times.get(block);
        if (t === undefined) throw new Error(`no time for ${range.chain} calm block ${block}`);
        return t;
      }),
    );
  }
  writeGz(CALM_PRICES_FILE, out);
  return out;
}

interface Converted {
  member: number;
  applyBlock: number;
  applyT: number;
  readBlock: number;
  readT: number;
  code: number;
  emode: number;
  hf: number;
  balances: Array<[asset: number, supply: number, debt: number, collateral: number]>;
}

function codeOf(read: UserRead): number {
  if (read.kind === 'start') return ReadCode.Start;
  if (read.kind === 'preliq') return ReadCode.BeforeLiquidation;
  return read.full ? ReadCode.Joined : ReadCode.Partial;
}

export async function derivePeriod(range: BlockRange, book: PriceBook, inHeadline: Set<string>): Promise<PopulationFile> {
  const { chain, window: period } = range;
  const market = marketsFor(range).find((m) => m.block === range.fromBlock)!;
  const assets = market.reserves.map((r) => r.asset);
  const assetIndex = new Map(assets.map((a, i) => [a, i]));
  const usdc = assetIndex.get(CHAINS[chain].usdc.toLowerCase())!;
  const start = await readStart(range);
  const plan = await planRange(range, inHeadline);
  const startMembers = [...plan.startMembers].sort();
  const joined = [...plan.joined.keys()].filter((u) => !plan.startMembers.has(u)).sort();
  const members = [...startMembers, ...joined];
  const memberIndex = new Map(members.map((u, i) => [u, i]));

  // Reads, scaled by the indexes read in the same call.
  const converted: Converted[] = [];
  for (const row of await readReads(range)) {
    const index = new Map(row.indexes.map(([asset, income, debt]) => [asset, { income: Number(BigInt(income)) / RAY, debt: Number(BigInt(debt)) / RAY }]));
    for (const read of row.users) {
      const member = memberIndex.get(read.user);
      if (member === undefined) throw new Error(`read for unknown member ${read.user}`);
      const hf = BigInt(read.account[3]);
      converted.push({
        member,
        applyBlock: read.applyBlock,
        applyT: read.applyT,
        readBlock: row.block,
        readT: row.t,
        code: codeOf(read),
        emode: read.emode,
        hf: read.account[1] === '0' || hf > 10n ** 30n ? -1 : Math.round(Number(hf / 10n ** 14n)),
        balances: read.balances.map(([asset, supplied, variable, stable, collateral]) => {
          const i = assetIndex.get(asset);
          if (i === undefined) throw new Error(`reserve ${asset} not in the ${chain} ${period} market`);
          const unit = 10 ** market.reserves[i]!.decimals;
          const idx = index.get(asset)!;
          // Stable debt is folded into variable debt. Aave v3 on these pools has none left; derive reports any.
          if (stable !== '0') stableSeen.count++;
          return [i, significant(Number(supplied) / unit / idx.income), significant((Number(variable) + Number(stable)) / unit / idx.debt), collateral ? 1 : 0];
        }),
      });
    }
  }
  converted.sort((a, b) => a.member - b.member || a.applyBlock - b.applyBlock || a.code - b.code || a.readBlock - b.readBlock);

  // Hourly indexes and USDC rates.
  const indexRows = await readIndexes(range);
  const income = assets.map((_, i) => deltaEncode(indexRows.map((row) => Math.round((Number(BigInt(row[2][i]![0])) / RAY) * INDEX_UNIT))));
  const debt = assets.map((_, i) => deltaEncode(indexRows.map((row) => Math.round((Number(BigInt(row[2][i]![1])) / RAY) * INDEX_UNIT))));
  const usdcRates = {
    t: deltaEncode(indexRows.map((row) => row[1])),
    supplyApr: indexRows.map((row) => Math.round((Number(BigInt(row[2][usdc]![2])) / RAY) * 1e8)),
    borrowApr: indexRows.map((row) => Math.round((Number(BigInt(row[2][usdc]![3])) / RAY) * 1e8)),
  };

  // Liquidations of tracked members outside the headline set, with their first-episode bonus.
  const emodeBefore = new Map<number, number>();
  for (const c of converted) if (c.code === ReadCode.BeforeLiquidation) emodeBefore.set(c.member, c.emode);
  const events = new Map<number, Array<{ block: number; t: number; bonusUsd: number }>>();
  for (const log of readActionLogs(range)) {
    if (log.topics[0] !== TOPICS.liquidation) continue;
    const { args } = decodeEventLog({ abi: [LIQUIDATION_EVENT], data: log.data as `0x${string}`, topics: log.topics as [`0x${string}`, ...`0x${string}`[]] });
    const member = memberIndex.get(args.user.toLowerCase());
    if (member === undefined || !emodeBefore.has(member)) continue;
    const block = parseInt(log.blockNumber, 16);
    const collateral = market.reserves[assetIndex.get(args.collateralAsset.toLowerCase())!]!;
    const debtReserve = market.reserves[assetIndex.get(args.debtAsset.toLowerCase())!]!;
    const [debtPrice] = book.pricesAt([assetIndex.get(debtReserve.asset)!], block);
    const debtUsd = (Number(args.debtToCover) / 10 ** debtReserve.decimals) * debtPrice!;
    const bonus = inCategory(collateral, market, emodeBefore.get(member)!) ? market.emodes.find((e) => e.id === emodeBefore.get(member))!.liquidationBonus : collateral.liquidationBonus;
    const list = events.get(member) ?? [];
    list.push({ block, t: parseInt(log.blockTimestamp!, 16), bonusUsd: debtUsd * (bonus / 1e4 - 1) });
    events.set(member, list);
  }
  const liquidations: PopulationFile['liquidations'] = [];
  for (const [member, list] of [...events.entries()].sort(([a], [b]) => a - b)) {
    list.sort((a, b) => a.block - b.block);
    let total = 0;
    let previous = list[0]!.t;
    for (const event of list) {
      if (event.t - previous > EPISODE_GAP_SEC) break;
      total += event.bonusUsd;
      previous = event.t;
    }
    liquidations.push([member, list[0]!.block, list[0]!.t, Math.round(total * 100) / 100, list.length]);
  }

  const headline = members.flatMap((u, i) => (inHeadline.has(`${chain}:${period}:${u}`) ? [i] : []));
  let sum = 0n;
  for (const balance of start.balances.values()) sum += balance;

  // Delta-code reads within each member.
  const reads: PopulationFile['reads'] = { member: [], applyBlock: [], applyT: [], readLag: [], readLagT: [], code: [], emode: [], hf: [], n: [] };
  const balances: PopulationFile['balances'] = { asset: [], supply: [], debt: [], collateral: [] };
  let lastMember = 0;
  let lastBlock = 0;
  let lastT = 0;
  for (const c of converted) {
    if (c.member !== lastMember) {
      lastBlock = 0;
      lastT = 0;
    }
    reads.member.push(c.member - lastMember);
    reads.applyBlock.push(c.applyBlock - lastBlock);
    reads.applyT.push(c.applyT - lastT);
    reads.readLag.push(c.readBlock - c.applyBlock);
    reads.readLagT.push(c.readT - c.applyT);
    reads.code.push(c.code);
    reads.emode.push(c.emode);
    reads.hf.push(c.hf);
    reads.n.push(c.balances.length);
    for (const [asset, supply, owed, collateral] of c.balances) {
      balances.asset.push(asset);
      balances.supply.push(supply);
      balances.debt.push(owed);
      balances.collateral.push(collateral);
    }
    lastMember = c.member;
    lastBlock = c.applyBlock;
    lastT = c.applyT;
  }

  return {
    chain,
    period,
    fromBlock: range.fromBlock,
    toBlock: range.toBlock,
    fromTime: range.fromTimestamp,
    toTime: range.toTimestamp,
    assets,
    usdc,
    census: { candidates: start.candidates, startMembers: startMembers.length, newcomers: joined.length, totalSupply: start.totalSupply.toString(), sumOfStartBalances: sum.toString() },
    index: { t: deltaEncode(indexRows.map((row) => row[1])), income, debt },
    usdcRates,
    members,
    liquidations,
    headline,
    reads,
    balances,
  };
}

export async function derivePortfolio(only?: ChainKey, onlyPeriod?: string): Promise<void> {
  mkdirSync(PORTFOLIO_DIR, { recursive: true });
  const inHeadline = new Set(readPositions().filter((p) => p.scope !== 'no_usdc_debt').map((p) => p.id));
  const calm = onlyPeriod && onlyPeriod !== CALM_ID ? [] : await deriveCalmPrices();
  const books = new Map([...readWindowPrices(), ...calm].map((p) => [`${p.chain}:${p.window}`, new PriceBook(p)]));
  for (const range of allRanges()) {
    if (only && range.chain !== only) continue;
    if (onlyPeriod && range.window !== onlyPeriod) continue;
    const file = await derivePeriod(range, books.get(`${range.chain}:${range.window}`)!, inHeadline);
    writeGz(populationFile(range.chain, range.window), file);
    console.log(
      `${range.chain} ${range.window}: ${file.members.length} members (${file.census.startMembers} at start, ${file.census.newcomers} joined), ${file.reads.code.length} reads, ${file.liquidations.length} liquidated outside the headline set, ${file.headline.length} in it`,
    );
  }
  if (stableSeen.count > 0) console.log(`stable debt seen in ${stableSeen.count} balance entries, folded into variable debt`);
}

if (import.meta.url === `file://${process.argv[1]}`) await derivePortfolio(process.argv[2] as ChainKey | undefined, process.argv[3]);
