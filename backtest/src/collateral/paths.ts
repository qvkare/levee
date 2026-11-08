// Collateral-mode paths: every observation, no thinning, with the sold asset's oracle price, units
// and threshold at each point. README.md, "Method: repay from collateral", has the rules.
import { decodeObserved, type DerivedPosition } from '../data.ts';
import type { PriceBook } from '../frozen.ts';
import type { PeriodModel, State } from '../portfolio/model.ts';
import type { CollateralPath } from '../sim/unwind.ts';

/** Growable columns for a path. */
class Columns {
  n = 0;
  private cap = 256;
  t = new Float64Array(this.cap);
  block = new Float64Array(this.cap);
  capacity = new Float64Array(this.cap);
  debt = new Float64Array(this.cap);
  usdcDebt = new Float64Array(this.cap);
  price = new Float64Array(this.cap);
  units = new Float64Array(this.cap);
  lt = new Float64Array(this.cap);

  push(t: number, block: number, capacity: number, debt: number, usdcDebt: number, price: number, units: number, lt: number): void {
    if (this.n === this.cap) {
      this.cap *= 2;
      for (const key of ['t', 'block', 'capacity', 'debt', 'usdcDebt', 'price', 'units', 'lt'] as const) {
        const grown = new Float64Array(this.cap);
        grown.set(this[key]);
        this[key] = grown;
      }
    }
    const i = this.n++;
    this.t[i] = t;
    this.block[i] = block;
    this.capacity[i] = capacity;
    this.debt[i] = debt;
    this.usdcDebt[i] = usdcDebt;
    this.price[i] = price;
    this.units[i] = units;
    this.lt[i] = lt;
  }

  path(liquidation: CollateralPath['liquidation']): CollateralPath {
    const cut = (a: Float64Array): Float64Array => a.subarray(0, this.n);
    return {
      n: this.n,
      t: cut(this.t),
      block: cut(this.block),
      capacity: cut(this.capacity),
      debt: cut(this.debt),
      usdcDebt: cut(this.usdcDebt),
      price: cut(this.price),
      units: cut(this.units),
      lt: cut(this.lt),
      liquidation,
    };
  }
}

/** A position's collateral at arming, by oracle value, largest first; a tie goes to the asset listed first. */
export interface Holding {
  asset: number;
  units: number;
  valueUsd: number;
}

export const byValue = (a: Holding, b: Holding): number => b.valueUsd - a.valueUsd || a.asset - b.asset;

/** The largest holding with a usable pool, or null: `no_pool`. */
export function chooseAsset(holdings: Holding[], usable: (asset: number) => boolean): number | null {
  return [...holdings].sort(byValue).find((h) => usable(h.asset))?.asset ?? null;
}

/** Units of `asset` that count as collateral in `state`, in index segment h at weight w. */
function unitsIn(model: PeriodModel, state: State, asset: number, h: number, w: number): number {
  const i = state.collAsset.indexOf(asset);
  if (i < 0) return 0;
  return (state.collWeight[i]! / model.threshold(state.emode, asset)) * model.incomeAt(asset, h, w);
}

/** The collateral that counts in `state`, valued at a block and time. */
export function holdingsOf(model: PeriodModel, state: State, block: number, t: number): Holding[] {
  const row = model.rowAt(block);
  const [h, w] = model.segmentOf(t);
  return state.collAsset.map((asset) => {
    const units = unitsIn(model, state, asset, h, w);
    return { asset, units, valueUsd: units * model.priceAt(asset, row) };
  });
}

export interface MemberStart {
  arm: State;
  liquidation: { block: number; t: number } | null;
  /** States from arming on, before any liquidation. */
  states: State[];
}

/** Arming and liquidation as `PeriodModel.build` decides them. Null for a member never seen with USDC debt. */
export function memberStart(model: PeriodModel, member: number): MemberStart | null {
  const all = model.statesOf(member);
  const usdc = model.usdcAsset;
  const armIndex = all.findIndex((s) => {
    const i = s.debtAsset.indexOf(usdc);
    return i >= 0 && s.debtAmount[i]! > 0;
  });
  if (armIndex < 0) return null;
  const arm = all[armIndex]!;
  const real = model.liquidations.get(member) ?? null;
  const liquidation = real !== null && real.block > arm.applyBlock ? { block: real.block, t: real.t } : null;
  const states = all.slice(armIndex).filter((s) => liquidation === null || s.applyBlock < liquidation.block);
  return { arm, liquidation, states };
}

/**
 * A population member's path, rebuilt as `PeriodModel.build` does it but with every price row of its
 * assets and every read, from arming to the period end, frozen from a liquidation on.
 */
export function memberPath(model: PeriodModel, start: MemberStart, asset: number): CollateralPath {
  const { states, liquidation } = start;
  const assets = [...new Set(states.flatMap((s) => [...s.collAsset, ...s.debtAsset]))].sort((a, b) => a - b);
  const rows = model.rowsFor(assets);
  const out = new Columns();
  let hint = 0;
  const emit = (state: State, block: number, t: number, row: number): void => {
    const v = model.value(state, row, t, hint);
    hint = v.segment;
    const [h, w] = model.segmentOf(t, hint);
    out.push(t, block, v.capacity, v.debt, v.usdcDebt, model.priceAt(asset, row), unitsIn(model, state, asset, h, w), model.threshold(state.emode, asset));
  };

  let current = states[0]!;
  emit(current, current.applyBlock, current.applyT, model.rowAt(current.applyBlock));
  let s = 1;
  let r = 0;
  while (r < rows.length && model.blockOfRow(rows[r]!) <= current.applyBlock) r++;
  const stop = liquidation ? liquidation.block : Infinity;
  for (;;) {
    const rowBlock = r < rows.length ? model.blockOfRow(rows[r]!) : Infinity;
    const readBlock = s < states.length ? states[s]!.applyBlock : Infinity;
    const next = Math.min(rowBlock, readBlock);
    if (next >= stop || next === Infinity) break;
    if (readBlock === next) {
      current = states[s++]!;
      while (s < states.length && states[s]!.applyBlock === next) current = states[s++]!;
      if (rowBlock === next) {
        emit(current, next, model.timeOfRow(rows[r]!), rows[r]!);
        r++;
      } else {
        emit(current, next, current.applyT, model.rowAt(next));
      }
    } else {
      emit(current, next, model.timeOfRow(rows[r]!), rows[r]!);
      r++;
    }
  }
  if (liquidation) {
    emit(current, liquidation.block, liquidation.t, model.rowAt(liquidation.block));
    for (; r < rows.length; r++) {
      const row = rows[r]!;
      if (model.blockOfRow(row) <= liquidation.block) continue;
      emit(current, model.blockOfRow(row), model.timeOfRow(row), row);
    }
  }
  return out.path(liquidation);
}

/** The state a headline position's observation falls in: the last read at or before it, else the first read. */
function stateFor(model: PeriodModel, member: number, block: number): State {
  return model.stateAt(member, block) ?? model.statesOf(member)[0]!;
}

/** A headline position's arming block and time: its first observation with debt. */
export function headlineArming(position: DerivedPosition): { block: number; t: number } {
  const first = decodeObserved(position.observed!).find((p) => p[3] > 0);
  if (!first) throw new Error(`${position.id} has no debt`);
  return { block: first[0], t: first[1] };
}

/**
 * A headline position's path: its committed observations, then its frozen portfolio at every price
 * update after the liquidation. The sold asset's units and threshold come from the member's rebuilt
 * reads before the liquidation and from the frozen portfolio after it.
 */
export function headlinePath(model: PeriodModel, member: number, book: PriceBook, position: DerivedPosition, asset: number): CollateralPath {
  const out = new Columns();
  const share = position.usdcShare;
  let hint = 0;
  for (const [block, t, capacity, debt] of decodeObserved(position.observed!)) {
    const state = stateFor(model, member, block);
    const [h, w] = model.segmentOf(t, hint);
    hint = h;
    out.push(t, block, capacity, debt, share * debt, book.pricesAt([asset], block)[0]!, unitsIn(model, state, asset, h, w), model.threshold(state.emode, asset));
  }
  const frozen = position.portfolio!.collateral.find(([a]) => a === asset);
  const units = frozen ? frozen[1] : 0;
  const lt = frozen ? frozen[2] / 1e4 : 0;
  for (const [block, t, capacity, debt] of book.frozenPoints(position.portfolio!, position.liquidationBlock, position.liquidationTime)) {
    out.push(t, block, capacity, debt, share * debt, book.pricesAt([asset], block)[0]!, units, lt);
  }
  return out.path({ block: position.liquidationBlock, t: position.liquidationTime });
}

/** A headline position's collateral at arming, from the member's rebuilt reads and the window's prices. */
export function headlineHoldings(model: PeriodModel, member: number, book: PriceBook, position: DerivedPosition): Holding[] {
  const { block, t } = headlineArming(position);
  const state = stateFor(model, member, block);
  const [h, w] = model.segmentOf(t);
  return state.collAsset.map((asset) => {
    const units = unitsIn(model, state, asset, h, w);
    return { asset, units, valueUsd: units * book.pricesAt([asset], block)[0]! };
  });
}
