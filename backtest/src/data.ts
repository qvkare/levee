// The committed data set. `derive` writes it, `pnpm backtest` reads it.
//
// Columns are delta-coded integers, which gzip far better than repeated large numbers.
// Paths after a liquidation are not stored: they are rebuilt from each position's portfolio
// and the asset price series, which keeps the files small and the numbers auditable.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { ChainKey } from './config.ts';
import { DERIVED_DIR } from './paths.ts';
import type { ScopeClass } from './scope.ts';

export const POSITIONS_FILE = join(DERIVED_DIR, 'positions.jsonl.gz');
export const PRICES_FILE = join(DERIVED_DIR, 'prices.json.gz');
export const VALIDATION_FILE = join(DERIVED_DIR, 'validation.json');

export interface DerivedEvent {
  block: number;
  t: number;
  tx: string;
  collateral: string;
  debt: string;
  debtUsd: number;
  /** Gross bonus: what the borrower lost, including the protocol's share. */
  bonusUsd: number;
}

/** block, unix seconds, capacity USD, debt USD. */
export type CompactPoint = [block: number, t: number, capacity: number, debt: number];

/**
 * Delta-coded. `hf` is HF × 1e4, and capacity is rebuilt as hf × debt. `debt` counts multiples
 * of `debtUnit`, which keeps six significant digits of the position's largest debt: enough for
 * the simulation, and it drops the interest noise that gzip cannot compress.
 */
export interface ObservedColumns {
  block: number[];
  t: number[];
  hf: number[];
  debt: number[];
  debtUnit: number;
}

/** Indices point into the window's price series. Amounts are in whole tokens. */
export interface Portfolio {
  collateral: Array<[asset: number, amount: number, thresholdBps: number]>;
  debt: Array<[asset: number, amount: number]>;
}

export interface DerivedPosition {
  id: string;
  chain: ChainKey;
  window: string;
  user: string;
  scope: ScopeClass;
  usdcShare: number;
  emode: number;
  /** Largest debt reserve by USD, with its address, so bridged USDC stays visible. */
  largestDebt: { symbol: string; asset: string };
  /** getUserAccountData at the block before the first liquidation. */
  debtUsd: number;
  collateralUsd: number;
  liquidationBlock: number;
  liquidationTime: number;
  events: DerivedEvent[];
  /** In-scope positions only. */
  observed?: ObservedColumns;
  portfolio?: Portfolio;
}

/** One asset's AaveOracle price, stored only where it changed. */
export interface PriceSeries {
  symbol: string;
  asset: string;
  /** Delta-coded indices into the window's block and time columns. */
  at: number[];
  /** Delta-coded 8-decimal USD prices. */
  price: number[];
}

export interface WindowPrices {
  chain: ChainKey;
  window: string;
  /** Delta-coded, one entry per block with a price row. */
  block: number[];
  t: number[];
  series: PriceSeries[];
}

export function deltaEncode(values: number[]): number[] {
  return values.map((value, i) => (i === 0 ? value : value - values[i - 1]!));
}

export function deltaDecode(deltas: number[]): number[] {
  const values: number[] = [];
  let total = 0;
  for (const delta of deltas) {
    total += delta;
    values.push(total);
  }
  return values;
}

export function encodeObserved(points: CompactPoint[]): ObservedColumns {
  const largest = Math.max(0, ...points.map((p) => p[3]));
  const debtUnit = largest > 0 ? 10 ** (Math.floor(Math.log10(largest)) - 5) : 1;
  return {
    block: deltaEncode(points.map((p) => p[0])),
    t: deltaEncode(points.map((p) => p[1])),
    hf: deltaEncode(points.map((p) => (p[3] > 0 ? Math.round((p[2] / p[3]) * 1e4) : 0))),
    debt: deltaEncode(points.map((p) => Math.round(p[3] / debtUnit))),
    debtUnit,
  };
}

export function decodeObserved(columns: ObservedColumns): CompactPoint[] {
  const block = deltaDecode(columns.block);
  const t = deltaDecode(columns.t);
  const hf = deltaDecode(columns.hf);
  const debt = deltaDecode(columns.debt);
  return block.map((b, i) => {
    const debtUsd = debt[i]! * columns.debtUnit;
    return [b, t[i]!, (hf[i]! / 1e4) * debtUsd, debtUsd];
  });
}

export function writePositions(positions: DerivedPosition[]): void {
  const text = positions.map((p) => JSON.stringify(p)).join('\n') + '\n';
  writeFileSync(POSITIONS_FILE, gzipSync(text, { level: 9 }));
}

export function readPositions(): DerivedPosition[] {
  return gunzipSync(readFileSync(POSITIONS_FILE))
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DerivedPosition);
}

export function writePrices(prices: WindowPrices[]): void {
  writeFileSync(PRICES_FILE, gzipSync(JSON.stringify(prices), { level: 9 }));
}

export function readPrices(): WindowPrices[] {
  return JSON.parse(gunzipSync(readFileSync(PRICES_FILE)).toString('utf8')) as WindowPrices[];
}
