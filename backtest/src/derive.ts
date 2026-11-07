// Raw reads to compact committed files, and the measured error of the frozen-portfolio
// method. Reads data/raw only; no network.
import type { ChainKey } from './config.ts';
import { CHAINS } from './config.ts';
import { VALIDATION_FILE, writePositions, type CompactPoint, type DerivedEvent, type DerivedPosition } from './data.ts';
import { BLOCKS_FILE, type BlockRange } from './fetch/blocks.ts';
import type { Liquidation } from './fetch/liquidations.ts';
import { readOracleUpdates } from './fetch/oracle.ts';
import { FINE_CEILING, readPaths, sortedUsers, type Sample } from './fetch/paths.ts';
import { loadPositions, type PositionKey } from './fetch/positions.ts';
import { readPrices } from './fetch/prices.ts';
import { MARKETS_FILE, type EModeCategory, type MarketSnapshot, type Reserve } from './fetch/reserves.ts';
import { marketAt, readSnapshots, type Snapshot } from './fetch/snapshots.ts';
import { readTimes } from './fetch/times.ts';
import { GRID } from './grid.ts';
import { readJson, writeJson } from './paths.ts';
import { classify } from './scope.ts';
import { thinFrozen, thinObserved } from './thin.ts';

class PricePath {
  private readonly blocks: number[];
  constructor(private readonly rows: Map<number, number[]>) {
    this.blocks = [...rows.keys()].sort((a, b) => a - b);
  }
  /** Prices in force at the end of `block`. */
  at(block: number): number[] {
    let low = 0;
    let high = this.blocks.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (this.blocks[mid]! <= block) low = mid;
      else high = mid - 1;
    }
    return this.rows.get(this.blocks[low]!)!;
  }
}

interface Holding {
  index: number;
  amount: number;
  /** Basis points; zero for a supply not used as collateral. */
  threshold: number;
}

function inCategory(reserve: Reserve, category: EModeCategory | undefined): boolean {
  return category !== undefined && (BigInt(category.collateralBitmap) >> BigInt(reserve.id)) % 2n === 1n;
}

function portfolio(snapshot: Snapshot, market: MarketSnapshot): { collateral: Holding[]; debt: Holding[] } {
  const category = market.emodes.find((e) => e.id === snapshot.emode);
  const collateral: Holding[] = [];
  const debt: Holding[] = [];
  for (const [asset, supplied, borrowed, used] of snapshot.reserves) {
    const index = market.reserves.findIndex((r) => r.asset === asset);
    const reserve = market.reserves[index]!;
    const unit = 10 ** reserve.decimals;
    const threshold = inCategory(reserve, category) ? category!.liquidationThreshold : reserve.liquidationThreshold;
    if (used && threshold > 0 && supplied !== '0') collateral.push({ index, amount: Number(supplied) / unit, threshold });
    if (borrowed !== '0') debt.push({ index, amount: Number(borrowed) / unit, threshold: 0 });
  }
  return { collateral, debt };
}

function frozenAt(holdings: { collateral: Holding[]; debt: Holding[] }, prices: number[]): { capacity: number; debt: number } {
  let capacity = 0;
  let debt = 0;
  for (const h of holdings.collateral) capacity += (h.amount * prices[h.index]!) / 1e8 * (h.threshold / 1e4);
  for (const h of holdings.debt) debt += (h.amount * prices[h.index]!) / 1e8;
  return { capacity, debt };
}

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

interface Validation {
  chain: ChainKey;
  window: string;
  positions: number;
  inScope: number;
  /** Frozen HF against direct HF at the block before liquidation. */
  errorAtSnapshot: number[];
  /** Largest |frozen / direct - 1| across observed points in the last two hours, per position. */
  errorRunUp: number[];
  hfAtLiquidationBelow1: number;
  hfAtLiquidationAbove1: number;
  bonusRatioError: number[];
}

function eventRecord(event: Liquidation, market: MarketSnapshot, snapshot: Snapshot | undefined, prices: PricePath, t: number, validation: Validation): DerivedEvent {
  const collateralIndex = market.reserves.findIndex((r) => r.asset === event.collateralAsset);
  const debtIndex = market.reserves.findIndex((r) => r.asset === event.debtAsset);
  const collateral = market.reserves[collateralIndex]!;
  const debt = market.reserves[debtIndex]!;
  const row = prices.at(event.block);
  const debtUsd = (Number(event.debtToCover) / 10 ** debt.decimals) * (row[debtIndex]! / 1e8);
  const category = market.emodes.find((e) => e.id === snapshot?.emode);
  const bonus = inCategory(collateral, category) ? category!.liquidationBonus : collateral.liquidationBonus;
  const bonusUsd = debtUsd * (bonus / 1e4 - 1);

  // The event reports collateral net of the protocol's cut of the bonus.
  const seizedUsd = (Number(event.collateralAmount) / 10 ** collateral.decimals) * (row[collateralIndex]! / 1e8);
  const expected = 1 + (bonus / 1e4 - 1) * (1 - collateral.protocolFee / 1e4);
  if (debtUsd > 100) validation.bonusRatioError.push(seizedUsd / debtUsd / expected - 1);

  return { block: event.block, t, tx: event.tx, collateral: collateral.symbol, debt: debt.symbol, debtUsd: round2(debtUsd), bonusUsd: round2(bonusUsd) };
}

const round2 = (x: number): number => Math.round(x * 100) / 100;
const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

function usdcPriceAt(market: MarketSnapshot, chain: ChainKey, prices: number[]): number {
  const index = market.reserves.findIndex((r) => r.asset === CHAINS[chain].usdc.toLowerCase());
  return prices[index]! / 1e8;
}

function largestDebt(snapshot: Snapshot, market: MarketSnapshot, prices: number[]): { symbol: string; asset: string } {
  let best = { symbol: 'none', asset: '', usd: -1 };
  for (const [asset, , borrowed] of snapshot.reserves) {
    if (borrowed === '0') continue;
    const index = market.reserves.findIndex((r) => r.asset === asset);
    const reserve = market.reserves[index]!;
    const usd = (Number(borrowed) / 10 ** reserve.decimals) * (prices[index]! / 1e8);
    if (usd > best.usd) best = { symbol: reserve.symbol, asset, usd };
  }
  return { symbol: best.symbol, asset: best.asset };
}

function observedPoints(samples: Sample[], blockTime: (block: number) => number): CompactPoint[] {
  const points: CompactPoint[] = [];
  for (const sample of samples) {
    const debt = sample.debt / 1e8;
    const capacity = sample.hf === null ? ((sample.collateral / 1e8) * sample.threshold) / 1e4 : sample.hf * debt;
    points.push([sample.block, blockTime(sample.block), round2(capacity), round2(debt)]);
  }
  return points;
}

async function deriveWindow(range: BlockRange, markets: MarketSnapshot[], all: PositionKey[]): Promise<{ positions: DerivedPosition[]; validation: Validation }> {
  const { chain, window } = range;
  const market = marketAt(markets, chain, window);
  const snapshots = await readSnapshots(chain, window);
  const prices = new PricePath(await readPrices(chain, window));
  const times = await readTimes(chain);
  const updates = readOracleUpdates(chain, window, range);
  const paths = await readPaths(chain, window);
  const users = sortedUsers(all, chain, window);
  const userIndex = new Map(users.map((u, i) => [u, i]));
  const feedTimes = new Map(updates.map((u) => [u.block, u.t]));
  const blockTime = (block: number): number => {
    if (block === range.fromBlock) return range.fromTimestamp;
    const t = feedTimes.get(block) ?? times.get(block);
    if (t === undefined) throw new Error(`no timestamp for ${chain} block ${block}`);
    return t;
  };
  const updatesByFeed = new Map<string, Array<{ block: number; t: number }>>();
  for (const update of updates) {
    const list = updatesByFeed.get(update.aggregator) ?? [];
    list.push({ block: update.block, t: update.t });
    updatesByFeed.set(update.aggregator, list);
  }

  const validation: Validation = {
    chain,
    window,
    positions: 0,
    inScope: 0,
    errorAtSnapshot: [],
    errorRunUp: [],
    hfAtLiquidationBelow1: 0,
    hfAtLiquidationAbove1: 0,
    bonusRatioError: [],
  };
  const positions: DerivedPosition[] = [];

  for (const position of all) {
    if (position.chain !== chain || position.window !== window) continue;
    validation.positions++;
    const snapshot = snapshots.get(position.user);
    if (!snapshot) throw new Error(`missing snapshot ${chain} ${window} ${position.user}`);
    const firstBlock = position.firstBlock;
    const liquidationTime = times.get(firstBlock);
    if (liquidationTime === undefined) throw new Error(`no timestamp for liquidation block ${firstBlock}`);
    const snapshotPrices = prices.at(snapshot.block);
    const debtUsd = Number(snapshot.account.debt) / 1e8;
    const { scope, usdcShare } = classify(chain, snapshot.reserves, debtUsd, usdcPriceAt(market, chain, snapshotPrices));
    const events = position.events.map((e) => eventRecord(e, market, snapshot, prices, times.get(e.block)!, validation));

    const record: DerivedPosition = {
      id: `${chain}:${window}:${position.user}`,
      chain,
      window,
      user: position.user,
      scope,
      usdcShare: round6(usdcShare),
      emode: snapshot.emode,
      largestDebt: largestDebt(snapshot, market, snapshotPrices),
      debtUsd: round2(debtUsd),
      collateralUsd: round2(Number(snapshot.account.collateral) / 1e8),
      liquidationBlock: firstBlock,
      liquidationTime,
      events,
    };

    if (scope !== 'no_usdc_debt') {
      validation.inScope++;
      const holdings = portfolio(snapshot, market);
      const samples = (paths.get(userIndex.get(position.user)!) ?? []).filter((s) => s.block < firstBlock);
      if (samples.length === 0) throw new Error(`no path for ${record.id}`);

      // How well the frozen portfolio matches the protocol's own numbers.
      const atSnapshot = frozenAt(holdings, snapshotPrices);
      const directHf = Number(snapshot.account.healthFactor) / 1e18;
      if (atSnapshot.debt > 0 && Number.isFinite(directHf) && directHf < 100) {
        validation.errorAtSnapshot.push(atSnapshot.capacity / atSnapshot.debt / directHf - 1);
      }
      let worst = 0;
      for (const sample of samples) {
        if (sample.hf === null || blockTime(sample.block) < liquidationTime - 7200) continue;
        const frozen = frozenAt(holdings, prices.at(sample.block));
        if (frozen.debt > 0) worst = Math.max(worst, Math.abs(frozen.capacity / frozen.debt / sample.hf - 1));
      }
      validation.errorRunUp.push(worst);

      const atLiquidation = frozenAt(holdings, prices.at(firstBlock));
      if (atLiquidation.capacity / atLiquidation.debt < 1) validation.hfAtLiquidationBelow1++;
      else validation.hfAtLiquidationAbove1++;

      const observed = thinObserved(observedPoints(samples, blockTime), { triggers: GRID.triggers, ceiling: FINE_CEILING });

      // From the liquidation on, the portfolio stays frozen against every update of its feeds.
      const feeds = new Set(snapshot.reserves.flatMap(([asset]) => market.reserves.find((r) => r.asset === asset)?.feeds ?? []));
      const frozenBlocks = new Map<number, number>();
      for (const feed of feeds) {
        for (const update of updatesByFeed.get(feed) ?? []) {
          if (update.block > firstBlock) frozenBlocks.set(update.block, update.t);
        }
      }
      const frozenRaw: CompactPoint[] = [[firstBlock, liquidationTime, round2(atLiquidation.capacity), round2(atLiquidation.debt)]];
      for (const block of [...frozenBlocks.keys()].sort((a, b) => a - b)) {
        const value = frozenAt(holdings, prices.at(block));
        frozenRaw.push([block, frozenBlocks.get(block)!, round2(value.capacity), round2(value.debt)]);
      }
      const frozen = thinFrozen(frozenRaw);
      record.points = [...observed, ...frozen];
      record.frozenFrom = observed.length;
    }
    positions.push(record);
  }
  return { positions, validation };
}

function summarize(values: number[]): Record<string, number> {
  const sorted = values.map(Math.abs).sort((a, b) => a - b);
  return {
    n: sorted.length,
    median: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? NaN,
  };
}

export async function derive(): Promise<void> {
  const ranges = readJson<BlockRange[]>(BLOCKS_FILE);
  const markets = readJson<MarketSnapshot[]>(MARKETS_FILE);
  const all = loadPositions();
  const positions: DerivedPosition[] = [];
  const reports: unknown[] = [];
  const pooled = { errorAtSnapshot: [] as number[], errorRunUp: [] as number[], bonus: [] as number[], below: 0, above: 0 };
  for (const range of ranges) {
    const { positions: part, validation } = await deriveWindow(range, markets, all);
    positions.push(...part);
    pooled.errorAtSnapshot.push(...validation.errorAtSnapshot);
    pooled.errorRunUp.push(...validation.errorRunUp);
    pooled.bonus.push(...validation.bonusRatioError);
    pooled.below += validation.hfAtLiquidationBelow1;
    pooled.above += validation.hfAtLiquidationAbove1;
    reports.push({
      chain: validation.chain,
      window: validation.window,
      positions: validation.positions,
      inScope: validation.inScope,
      frozenVsDirectAtSnapshot: summarize(validation.errorAtSnapshot),
      frozenVsDirectRunUpWorstPerPosition: summarize(validation.errorRunUp),
      frozenHfBelow1AtLiquidation: validation.hfAtLiquidationBelow1,
      frozenHfAtOrAbove1AtLiquidation: validation.hfAtLiquidationAbove1,
      bonusRatioError: summarize(validation.bonusRatioError),
    });
    console.log(JSON.stringify(reports[reports.length - 1]));
  }
  writePositions(positions);
  writeJson(VALIDATION_FILE, {
    perWindow: reports,
    pooled: {
      frozenVsDirectAtSnapshot: summarize(pooled.errorAtSnapshot),
      frozenVsDirectRunUpWorstPerPosition: summarize(pooled.errorRunUp),
      runUpWithin0_5Pct: pooled.errorRunUp.filter((e) => e <= 0.005).length / pooled.errorRunUp.length,
      frozenHfBelow1AtLiquidation: pooled.below,
      frozenHfAtOrAbove1AtLiquidation: pooled.above,
      bonusRatioError: summarize(pooled.bonus),
    },
  });
}

if (import.meta.url === `file://${process.argv[1]}`) await derive();
