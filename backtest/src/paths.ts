import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** Raw responses as fetched. Git-ignored. Re-created by `pnpm fetch-data`. */
export const RAW_DIR = join(ROOT, 'data', 'raw');
/** Compact files derived from raw data. Committed; `pnpm backtest` reads only these. */
export const DERIVED_DIR = join(ROOT, 'data', 'derived');
export const RESULTS_DIR = join(ROOT, 'results');

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function writeJson(path: string, value: unknown, pretty = true): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, pretty ? 2 : 0) + '\n');
}

export { existsSync };
