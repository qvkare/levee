// After the first real liquidation there is nothing left to observe: the real position has
// changed. The counterfactual holds the pre-liquidation portfolio fixed and marks it to the
// oracle. Assumes the owner does nothing and ignores interest, which over a few days is
// small next to the price moves. The measured error is in data/derived/validation.json.
import { deltaDecode, type CompactPoint, type Portfolio, type WindowPrices } from './data.ts';
import { thinFrozen } from './thin.ts';

const round2 = (x: number): number => Math.round(x * 100) / 100;

/** Decoded prices for one window, with merged update lists cached per asset set. */
export class PriceBook {
  private readonly blocks: number[];
  private readonly times: number[];
  /** Per asset: indices into blocks where the price changed, and the price from then on. */
  private readonly series: Array<{ at: number[]; price: number[] }>;
  private readonly merged = new Map<string, number[]>();

  constructor(prices: WindowPrices) {
    this.blocks = deltaDecode(prices.block);
    this.times = deltaDecode(prices.t);
    this.series = prices.series.map((s) => ({ at: deltaDecode(s.at), price: deltaDecode(s.price) }));
  }

  /** Index of the last row at or before `block`. */
  private rowAt(block: number): number {
    let low = 0;
    let high = this.blocks.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (this.blocks[mid]! <= block) low = mid;
      else high = mid - 1;
    }
    return low;
  }

  /** Position of the last change of `asset` at or before `row`, or -1. */
  private changeAt(asset: number, row: number): number {
    const { at } = this.series[asset]!;
    let low = -1;
    let high = at.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (at[mid]! <= row) low = mid;
      else high = mid - 1;
    }
    return low;
  }

  private updatesOf(assets: number[]): number[] {
    const key = assets.join(',');
    const cached = this.merged.get(key);
    if (cached) return cached;
    const rows = new Set<number>();
    for (const asset of assets) for (const row of this.series[asset]!.at) rows.add(row);
    const sorted = [...rows].sort((a, b) => a - b);
    this.merged.set(key, sorted);
    return sorted;
  }

  /** USD prices of `assets`, in order, at the end of `block`. */
  pricesAt(assets: number[], block: number): number[] {
    const row = this.rowAt(block);
    return assets.map((asset) => {
      const change = this.changeAt(asset, row);
      if (change < 0) throw new Error(`no price for asset ${asset} at block ${block}`);
      return this.series[asset]!.price[change]! / 1e8;
    });
  }

  /** The portfolio marked at the liquidation block and at every later update of its assets. */
  frozenPath(portfolio: Portfolio, fromBlock: number, fromTime: number): CompactPoint[] {
    const assets = [...new Set([...portfolio.collateral.map(([a]) => a), ...portfolio.debt.map(([a]) => a)])].sort((a, b) => a - b);
    const slot = new Map(assets.map((asset, i) => [asset, i]));
    const collateral = portfolio.collateral.map(([asset, amount, threshold]) => ({ slot: slot.get(asset)!, value: (amount * threshold) / 1e4 }));
    const debt = portfolio.debt.map(([asset, amount]) => ({ slot: slot.get(asset)!, value: amount }));
    const prices = this.pricesAt(assets, fromBlock);
    const point = (block: number, t: number): CompactPoint => {
      let capacity = 0;
      let owed = 0;
      for (const c of collateral) capacity += c.value * prices[c.slot]!;
      for (const d of debt) owed += d.value * prices[d.slot]!;
      return [block, t, round2(capacity), round2(owed)];
    };

    const points: CompactPoint[] = [point(fromBlock, fromTime)];
    const startRow = this.rowAt(fromBlock);
    const cursors = assets.map((asset) => this.changeAt(asset, startRow));
    for (const row of this.updatesOf(assets)) {
      if (row <= startRow) continue;
      assets.forEach((asset, i) => {
        const series = this.series[asset]!;
        const next = cursors[i]! + 1;
        if (series.at[next] === row) {
          cursors[i] = next;
          prices[i] = series.price[next]! / 1e8;
        }
      });
      points.push(point(this.blocks[row]!, this.times[row]!));
    }
    return thinFrozen(points);
  }
}
