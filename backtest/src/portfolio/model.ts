// Rebuilds each population member's path from its committed reads, the period's AaveOracle
// prices and the hourly reserve indexes. HF is evaluated at every price update of the member's
// assets and at every read, as README.md describes. Pure: no I/O.
import { CHAINS } from '../config.ts';
import { deltaDecode, type WindowPrices } from '../data.ts';
import type { MarketSnapshot } from '../fetch/reserves.ts';
import { GRID } from '../grid.ts';
import type { TrackedPath, TrackedPoint } from '../sim/tracked.ts';
import { INDEX_UNIT, ReadCode, type PopulationFile } from './data.ts';

/** A member's holdings after a read: per asset, scaled supply, scaled variable debt, collateral flag. */
export type Holdings = Map<number, { supply: number; debt: number; collateral: boolean }>;

export interface State {
  applyBlock: number;
  applyT: number;
  readBlock: number;
  readT: number;
  code: number;
  emode: number;
  /** getUserAccountData HF at the read block, or -1. */
  directHf: number;
  holdings: Holdings;
  /** Collateral that counts: asset, and scaled supply × liquidation threshold under this eMode. */
  collAsset: number[];
  collWeight: number[];
  /** Debt: asset and scaled amount. */
  debtAsset: number[];
  debtAmount: number[];
}

export interface MemberPath {
  member: number;
  user: string;
  /** Thinned for the simulation. Every trigger crossing, read and low is kept. */
  path: TrackedPath;
  armBlock: number;
  armT: number;
  armDebt: number;
  armHf: number;
  /** Lowest HF from arming to the real liquidation, or to the period end. Exact, before thinning. */
  minHf: number;
  /** First-episode gross bonus, if liquidated. */
  bonusUsd: number;
  /** Size of the unthinned path. */
  evaluated: number;
}

/** Points kept once HF moves this far from the last kept point below FAR. */
const HF_TOLERANCE = 0.0015;
/** Above every trigger in the grid, with margin. */
const FAR = 1.4;
const DEBT_TOLERANCE = 0.002;
const THRESHOLDS = [1, ...GRID.triggers];
/** Rows are grouped in chunks for the skip test. */
const CHUNK = 256;

export class PeriodModel {
  readonly members: string[];
  readonly headline: Set<number>;
  readonly liquidations: Map<number, { block: number; t: number; bonusUsd: number }>;
  private readonly blocks: number[];
  private readonly times: number[];
  private readonly price: Float64Array[];
  private readonly changeRows: number[][];
  private readonly merged = new Map<string, Int32Array>();
  private readonly indexT: number[];
  private readonly income: Float64Array[];
  private readonly debtIndex: Float64Array[];
  /** Liquidation threshold as a fraction, per eMode id, per asset. */
  private readonly lt = new Map<number, Float64Array>();
  private readonly usdc: number;
  /** Per member, its reads decoded, in file order. */
  private readonly states: State[][];
  /** Per asset, lowest and highest price in each chunk of rows. */
  private readonly chunkMin: Float64Array[];
  private readonly chunkMax: Float64Array[];
  /** Indexes only grow: the first income and the last debt index bound every time in between. */
  private readonly incomeFloor: Float64Array;
  private readonly debtCeiling: Float64Array;
  /** Members whose rows were skipped in part, and rows skipped. */
  skipped = { members: 0, rows: 0 };

  constructor(
    readonly file: PopulationFile,
    prices: WindowPrices,
    readonly market: MarketSnapshot,
    /** Off only to test that skipping changes nothing the simulation sees. */
    private readonly skip = true,
  ) {
    if (prices.series.length !== file.assets.length || prices.series.some((s, i) => s.asset !== file.assets[i])) throw new Error(`price and population assets differ for ${file.chain} ${file.period}`);
    this.members = file.members;
    this.headline = new Set(file.headline);
    this.liquidations = new Map(file.liquidations.map(([member, block, t, bonusUsd]) => [member, { block, t, bonusUsd }]));
    this.usdc = file.usdc;
    if (file.assets[file.usdc] !== CHAINS[file.chain].usdc.toLowerCase()) throw new Error('USDC index mismatch');

    this.blocks = deltaDecode(prices.block);
    this.times = deltaDecode(prices.t);
    const rows = this.blocks.length;
    this.changeRows = [];
    this.price = prices.series.map((series) => {
      const at = deltaDecode(series.at);
      const values = deltaDecode(series.price);
      this.changeRows.push(at);
      const dense = new Float64Array(rows).fill(NaN);
      for (let k = 0; k < at.length; k++) {
        const end = k + 1 < at.length ? at[k + 1]! : rows;
        dense.fill(values[k]! / 1e8, at[k]!, end);
      }
      return dense;
    });

    this.indexT = deltaDecode(file.index.t);
    this.income = file.index.income.map((column) => Float64Array.from(deltaDecode(column), (v) => v / INDEX_UNIT));
    this.debtIndex = file.index.debt.map((column) => Float64Array.from(deltaDecode(column), (v) => v / INDEX_UNIT));

    const base = Float64Array.from(market.reserves, (r) => r.liquidationThreshold / 1e4);
    this.lt.set(0, base);
    for (const category of market.emodes) {
      this.lt.set(
        category.id,
        Float64Array.from(market.reserves, (r, i) => ((BigInt(category.collateralBitmap) >> BigInt(r.id)) % 2n === 1n ? category.liquidationThreshold / 1e4 : base[i]!)),
      );
    }
    const chunks = Math.ceil(rows / CHUNK);
    this.chunkMin = this.price.map((dense) => {
      const out = new Float64Array(chunks).fill(Infinity);
      for (let r = 0; r < rows; r++) if (dense[r]! < out[Math.floor(r / CHUNK)]!) out[Math.floor(r / CHUNK)] = dense[r]!;
      return out;
    });
    this.chunkMax = this.price.map((dense) => {
      const out = new Float64Array(chunks).fill(-Infinity);
      for (let r = 0; r < rows; r++) if (dense[r]! > out[Math.floor(r / CHUNK)]!) out[Math.floor(r / CHUNK)] = dense[r]!;
      return out;
    });
    this.incomeFloor = Float64Array.from(this.income, (column) => Math.min(...column));
    this.debtCeiling = Float64Array.from(this.debtIndex, (column) => Math.max(...column));
    this.states = this.decodeStates();
  }

  /** A lower bound on HF over every row of chunk `c` for `state`. */
  private chunkBound(state: State, c: number): number {
    let capacity = 0;
    let debt = 0;
    for (let i = 0; i < state.collAsset.length; i++) {
      const a = state.collAsset[i]!;
      capacity += state.collWeight[i]! * this.incomeFloor[a]! * this.chunkMin[a]![c]!;
    }
    for (let i = 0; i < state.debtAsset.length; i++) {
      const a = state.debtAsset[i]!;
      debt += state.debtAmount[i]! * this.debtCeiling[a]! * this.chunkMax[a]![c]!;
    }
    return debt > 0 ? capacity / debt : Infinity;
  }

  private decodeStates(): State[][] {
    const { reads, balances } = this.file;
    const out: State[][] = this.members.map(() => []);
    let member = 0;
    let block = 0;
    let t = 0;
    let offset = 0;
    for (let i = 0; i < reads.code.length; i++) {
      const delta = reads.member[i]!;
      if (delta !== 0) {
        member += delta;
        block = 0;
        t = 0;
      }
      block += reads.applyBlock[i]!;
      t += reads.applyT[i]!;
      const list = out[member]!;
      const code = reads.code[i]!;
      const previous = list[list.length - 1];
      const holdings: Holdings = code === ReadCode.Partial && previous ? new Map(previous.holdings) : new Map();
      for (let k = 0; k < reads.n[i]!; k++, offset++) {
        holdings.set(balances.asset[offset]!, { supply: balances.supply[offset]!, debt: balances.debt[offset]!, collateral: balances.collateral[offset]! === 1 });
      }
      for (const [asset, h] of holdings) if (h.supply === 0 && h.debt === 0) holdings.delete(asset);
      const emode = reads.emode[i]!;
      const lt = this.lt.get(emode) ?? this.lt.get(0)!;
      const state: State = {
        applyBlock: block,
        applyT: t,
        readBlock: block + reads.readLag[i]!,
        readT: t + reads.readLagT[i]!,
        code,
        emode,
        directHf: reads.hf[i]!,
        holdings,
        collAsset: [],
        collWeight: [],
        debtAsset: [],
        debtAmount: [],
      };
      for (const [asset, h] of [...holdings].sort(([a], [b]) => a - b)) {
        if (h.supply > 0 && h.collateral && lt[asset]! > 0) {
          state.collAsset.push(asset);
          state.collWeight.push(h.supply * lt[asset]!);
        }
        if (h.debt > 0) {
          state.debtAsset.push(asset);
          state.debtAmount.push(h.debt);
        }
      }
      list.push(state);
    }
    return out;
  }

  statesOf(member: number): State[] {
    return this.states[member]!;
  }

  /** Index of the last price row at or before `block`. */
  rowAt(block: number): number {
    let low = 0;
    let high = this.blocks.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (this.blocks[mid]! <= block) low = mid;
      else high = mid - 1;
    }
    return low;
  }

  private rowsOf(assets: number[]): Int32Array {
    const key = assets.join(',');
    const cached = this.merged.get(key);
    if (cached) return cached;
    const set = new Set<number>();
    for (const asset of assets) for (const row of this.changeRows[asset]!) set.add(row);
    const sorted = Int32Array.from([...set].sort((a, b) => a - b));
    this.merged.set(key, sorted);
    return sorted;
  }

  /** Hourly segment and weight for time t, clamped to the sampled span. */
  private segment(t: number, hint: number): [number, number] {
    const ts = this.indexT;
    let h = Math.max(0, Math.min(hint, ts.length - 2));
    while (h > 0 && ts[h]! > t) h--;
    while (h < ts.length - 2 && ts[h + 1]! <= t) h++;
    const span = ts[h + 1]! - ts[h]!;
    const w = span > 0 ? Math.min(1, Math.max(0, (t - ts[h]!) / span)) : 0;
    return [h, w];
  }

  /** Capacity, debt and USDC debt of `state` at price row `row` and time `t`. */
  value(state: State, row: number, t: number, hint = 0): { capacity: number; debt: number; usdcDebt: number; segment: number } {
    const [h, w] = this.segment(t, hint);
    let capacity = 0;
    let debt = 0;
    let usdcDebt = 0;
    for (let i = 0; i < state.collAsset.length; i++) {
      const a = state.collAsset[i]!;
      const inc = this.income[a]!;
      capacity += state.collWeight[i]! * (inc[h]! + w * (inc[h + 1]! - inc[h]!)) * this.price[a]![row]!;
    }
    for (let i = 0; i < state.debtAsset.length; i++) {
      const a = state.debtAsset[i]!;
      const idx = this.debtIndex[a]!;
      const v = state.debtAmount[i]! * (idx[h]! + w * (idx[h + 1]! - idx[h]!)) * this.price[a]![row]!;
      debt += v;
      if (a === this.usdc) usdcDebt += v;
    }
    return { capacity, debt, usdcDebt, segment: h };
  }

  /** The state in force at the end of `block`: the last read applied at or before it. */
  stateAt(member: number, block: number): State | null {
    let found: State | null = null;
    for (const state of this.states[member]!) {
      if (state.applyBlock > block) break;
      found = state;
    }
    return found;
  }

  /** Rebuilt HF of a member at a block and time, with the state in force then. */
  hfAt(member: number, block: number, t: number): number {
    const state = this.stateAt(member, block);
    if (!state) return NaN;
    const v = this.value(state, this.rowAt(block), t);
    return v.debt > 0 ? v.capacity / v.debt : Infinity;
  }

  /**
   * The member's path from arming to the period end. A member liquidated in the period is
   * frozen from its first liquidation on, at its state from the block before. Returns null for
   * a member never seen with USDC debt.
   */
  build(member: number): MemberPath | null {
    const all = this.states[member]!;
    const usdcOf = (s: State): number => s.holdings.get(this.usdc)?.debt ?? 0;
    const armIndex = all.findIndex((s) => usdcOf(s) > 0);
    if (armIndex < 0) return null;
    const arm = all[armIndex]!;
    const liquidation = this.liquidations.get(member) ?? null;
    const liquidated = liquidation !== null && liquidation.block > arm.applyBlock ? liquidation : null;
    const states = all.slice(armIndex).filter((s) => liquidated === null || s.applyBlock < liquidated.block);

    const assets = [...new Set(states.flatMap((s) => [...s.holdings.keys()]))].sort((a, b) => a - b);
    const rows = this.rowsOf(assets);
    const points: TrackedPoint[] = [];
    let minHf = Infinity;
    let evaluated = 0;
    let hint = 0;

    // Thinning, inline. Below FAR: keep reads, threshold crossings, lows, and moves of 0.15% in
    // HF or 0.2% in debt from the last kept point below FAR. At or above FAR the keeper never
    // acts, so only reads and the first point after coming up from below FAR are kept. The set
    // kept below FAR therefore does not depend on which points above it were evaluated.
    let lastBelow: TrackedPoint | null = null;
    let previousHf = NaN;
    let low: TrackedPoint | null = null;
    const hfOf = (p: TrackedPoint): number => (p.debt > 0 ? p.capacity / p.debt : Infinity);
    const moved = (a: number, b: number, tol: number): boolean => (!Number.isFinite(a) || !Number.isFinite(b) ? a !== b : Math.abs(a / b - 1) >= tol);
    const emit = (point: TrackedPoint, force: boolean, observed: boolean): void => {
      evaluated++;
      const hf = hfOf(point);
      if (observed) minHf = Math.min(minHf, hf);
      let keep: boolean;
      if (hf >= FAR) {
        keep = force || points.length === 0 || !(previousHf >= FAR);
      } else {
        keep =
          force ||
          lastBelow === null ||
          !(previousHf < FAR) ||
          THRESHOLDS.some((x) => previousHf >= x !== hf >= x) ||
          moved(hf, hfOf(lastBelow), HF_TOLERANCE) ||
          moved(point.debt, lastBelow.debt, DEBT_TOLERANCE) ||
          moved(point.usdcDebt, lastBelow.usdcDebt, DEBT_TOLERANCE);
      }
      if (keep) {
        if (low && low !== point) points.push(low);
        points.push(point);
        if (hf < FAR) lastBelow = point;
        low = null;
      } else if (hf < FAR && (!low || hf < hfOf(low))) {
        low = point;
      }
      previousHf = hf;
    };
    const at = (state: State, block: number, t: number, row: number): TrackedPoint => {
      const v = this.value(state, row, t, hint);
      hint = v.segment;
      return { t, block, capacity: v.capacity, debt: v.debt, usdcDebt: v.usdcDebt };
    };

    // Arming, then rows and reads in block order. A read and a row in the same block make one point.
    let current = states[0]!;
    const armPoint = at(current, current.applyBlock, current.applyT, this.rowAt(current.applyBlock));
    emit(armPoint, true, true);
    let s = 1;
    let r = 0;
    while (r < rows.length && this.blocks[rows[r]!]! <= current.applyBlock) r++;
    const stop = liquidated ? liquidated.block : Infinity;
    let boundChunk = -1;
    let boundState: State | null = null;
    let boundOk = false;
    let skippedAny = false;
    for (;;) {
      const rowBlock = r < rows.length ? this.blocks[rows[r]!]! : Infinity;
      const readBlock = s < states.length ? states[s]!.applyBlock : Infinity;
      const next = Math.min(rowBlock, readBlock);
      if (next >= stop || next === Infinity) break;
      if (readBlock === next) {
        current = states[s++]!;
        while (s < states.length && states[s]!.applyBlock === next) current = states[s++]!;
        if (rowBlock === next) {
          emit(at(current, next, this.times[rows[r]!]!, rows[r]!), true, true);
          r++;
        } else {
          emit(at(current, next, current.applyT, this.rowAt(next)), true, true);
        }
      } else {
        // Skip the rest of this chunk when HF provably stays at or above FAR there. Above every
        // trigger the keeper does nothing, so the simulation is unchanged. Not for a liquidated
        // member, whose survival check needs every low.
        const row = rows[r]!;
        const c = Math.floor(row / CHUNK);
        if (this.skip && !liquidated) {
          if (c !== boundChunk || current !== boundState) {
            boundChunk = c;
            boundState = current;
            boundOk = this.chunkBound(current, c) >= FAR;
          }
          if (boundOk) {
            const end = (c + 1) * CHUNK;
            const before = r;
            while (r < rows.length && rows[r]! < end && this.blocks[rows[r]!]! < readBlock) r++;
            this.skipped.rows += r - before;
            skippedAny = true;
            continue;
          }
        }
        emit(at(current, next, this.times[row]!, row), false, true);
        r++;
      }
    }
    if (skippedAny) this.skipped.members++;
    if (liquidated) {
      // Frozen from the liquidation on, as in the headline method.
      emit(at(current, liquidated.block, liquidated.t, this.rowAt(liquidated.block)), true, false);
      for (; r < rows.length; r++) {
        const row = rows[r]!;
        if (this.blocks[row]! <= liquidated.block) continue;
        emit(at(current, this.blocks[row]!, this.times[row]!, row), false, false);
      }
    }
    if (low) points.push(low);

    return {
      member,
      user: this.members[member]!,
      path: { points, liquidation: liquidated ? { block: liquidated.block, t: liquidated.t } : null },
      armBlock: arm.applyBlock,
      armT: arm.applyT,
      armDebt: armPoint.debt,
      armHf: hfOf(armPoint),
      minHf,
      bonusUsd: liquidated ? liquidated.bonusUsd : 0,
      evaluated,
    };
  }
}
