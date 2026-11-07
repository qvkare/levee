// Which positions count. Decided by token address: "USDC" as a symbol also names USDC.e on
// Arbitrum, which native USDC cannot repay.
import type { ChainKey } from './config.ts';
import { CHAINS } from './config.ts';

export type ScopeClass = 'usdc_only' | 'usdc_mixed' | 'no_usdc_debt';

/** At or above this share of USDC debt a position counts as USDC only. */
export const USDC_ONLY_SHARE = 0.99;

export interface ScopeResult {
  scope: ScopeClass;
  /** Share of total debt USDC can repay, from 0 to 1. */
  usdcShare: number;
}

/** `debtUsd` is the account total. `usdcDebt` is in 6-decimal token units. */
export function classify(chain: ChainKey, reserves: Array<[string, string, string, boolean]>, debtUsd: number, usdcPrice: number): ScopeResult {
  const usdc = CHAINS[chain].usdc.toLowerCase();
  const row = reserves.find(([asset]) => asset === usdc);
  const usdcDebtUsd = row ? (Number(row[2]) / 1e6) * usdcPrice : 0;
  if (usdcDebtUsd <= 0 || debtUsd <= 0) return { scope: 'no_usdc_debt', usdcShare: 0 };
  const usdcShare = Math.min(1, usdcDebtUsd / debtUsd);
  return { scope: usdcShare >= USDC_ONLY_SHARE ? 'usdc_only' : 'usdc_mixed', usdcShare };
}
