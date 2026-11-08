/**
 * Aave's LTV-0 rule, spec section 9. If any collateral a borrower has enabled has an
 * LTV of zero, Aave lets only such an asset leave first: an aToken transfer of any
 * other collateral reverts with `LtvValidationFailed()`. From Aave v3.6 a frozen
 * reserve has its LTV set to zero, so a freeze of some other collateral in the account
 * blocks every unwind. The keeper reads the account and refuses to send that doomed
 * transaction. Pure: `replay` repeats it from the recorded reads.
 */
import { type Address, getAddress } from 'viem';

/** What Aave's `ValidationLogic.getUserReserveLtv` reads for a borrower in eMode. */
export interface EModeTerms {
  category: bigint;
  /** Reserves that are collateral in this category, by reserve index. */
  collateralBitmap: bigint;
  /** The category's LTV, basis points. */
  ltv: bigint;
  /** Aave v3.7: reserves set to LTV 0 inside this category. Zero before. */
  ltvzeroBitmap: bigint;
  /** Aave v3.7: an isolated category gives every other reserve an LTV of 0. */
  isolated: boolean;
}

export interface AccountLtv {
  /** `Pool.getReservesList()`, so that index i is reserve id i. */
  reserves: readonly Address[];
  /** `Pool.getUserConfiguration(borrower)`: bit 2i+1 is "reserve i is collateral". */
  userConfiguration: bigint;
  /** Each enabled collateral's reserve-level LTV, basis points, by reserve index. */
  reserveLtvBps: ReadonlyMap<number, bigint>;
  /** Null when the borrower is in no eMode category. */
  eMode: EModeTerms | null;
}

const bit = (bitmap: bigint, index: number): boolean => ((bitmap >> BigInt(index)) & 1n) === 1n;

/** Aave's `ReserveConfigurationMap`: LTV at bits 0 to 15. */
export const ltvOf = (configuration: bigint): bigint => configuration & 0xffffn;

/** Reserve indexes the borrower has enabled as collateral. */
export function collateralIndexes(reserveCount: number, userConfiguration: bigint): number[] {
  const indexes: number[] = [];
  for (let i = 0; i < reserveCount; i++) {
    if (bit(userConfiguration, 2 * i + 1)) indexes.push(i);
  }
  return indexes;
}

/** `ValidationLogic.getUserReserveLtv`, for the reserve at `index`. */
export function userReserveLtv(index: number, account: AccountLtv): bigint {
  const { eMode } = account;
  if (eMode && eMode.category !== 0n && bit(eMode.collateralBitmap, index)) {
    return bit(eMode.ltvzeroBitmap, index) ? 0n : eMode.ltv;
  }
  if (eMode && eMode.category !== 0n && eMode.isolated) return 0n;
  return account.reserveLtvBps.get(index) ?? 0n;
}

/**
 * The first other enabled collateral at LTV 0 that stops `asset` from leaving the
 * account, or null if nothing does. Nothing does when `asset` is not enabled as
 * collateral, since Aave then skips the check, or when `asset` is itself at LTV 0.
 */
export function ltvZeroBlocker(asset: Address, account: AccountLtv): Address | null {
  const target = account.reserves.findIndex(
    (reserve) => reserve.toLowerCase() === asset.toLowerCase(),
  );
  const enabled = collateralIndexes(account.reserves.length, account.userConfiguration);
  if (target < 0 || !enabled.includes(target)) return null;
  if (userReserveLtv(target, account) === 0n) return null;
  for (const index of enabled) {
    if (index === target) continue;
    const reserve = account.reserves[index];
    if (!reserve || /^0x0{40}$/i.test(reserve)) continue;
    if (userReserveLtv(index, account) === 0n) return getAddress(reserve);
  }
  return null;
}
