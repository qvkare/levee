// The committed data set. `derive` writes it, `pnpm backtest` reads it.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { ChainKey } from './config.ts';
import { DERIVED_DIR } from './paths.ts';
import type { ScopeClass } from './scope.ts';

export const POSITIONS_FILE = join(DERIVED_DIR, 'positions.jsonl.gz');
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
  /** In-scope positions only. Observed points, then frozen points from `frozenFrom` on. */
  points?: CompactPoint[];
  frozenFrom?: number;
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
