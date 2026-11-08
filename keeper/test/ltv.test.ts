import type { Address } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  type AccountLtv,
  type EModeTerms,
  collateralIndexes,
  ltvOf,
  ltvZeroBlocker,
  userReserveLtv,
} from '../src/ltv.js';

const WETH: Address = '0x4200000000000000000000000000000000000006';
const CBBTC: Address = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf';
const USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const DROPPED: Address = '0x0000000000000000000000000000000000000000';

/** Reserve i is collateral at bit 2i+1, borrowed at bit 2i. */
const collateralBit = (index: number) => 1n << BigInt(2 * index + 1);
const borrowedBit = (index: number) => 1n << BigInt(2 * index);

/** WETH is reserve 0, USDC 1, cbBTC 2. WETH and cbBTC are collateral, USDC borrowed. */
const account = (over: Partial<AccountLtv> = {}): AccountLtv => ({
  reserves: [WETH, USDC, CBBTC],
  userConfiguration: collateralBit(0) | borrowedBit(1) | collateralBit(2),
  reserveLtvBps: new Map([
    [0, 8_000n],
    [2, 7_300n],
  ]),
  eMode: null,
  ...over,
});

describe('collateralIndexes', () => {
  it('reads the collateral bits of the user configuration', () => {
    expect(collateralIndexes(3, account().userConfiguration)).toEqual([0, 2]);
    expect(collateralIndexes(3, borrowedBit(0) | borrowedBit(1))).toEqual([]);
  });
});

describe('ltvOf', () => {
  it('is bits 0 to 15 of the reserve configuration', () => {
    expect(ltvOf(8_000n | (8_300n << 16n) | (1n << 56n))).toBe(8_000n);
    expect(ltvOf(8_300n << 16n)).toBe(0n);
  });
});

describe('ltvZeroBlocker, as Aave validateHFAndLtvzero', () => {
  it('finds nothing when every collateral has an LTV', () => {
    expect(ltvZeroBlocker(WETH, account())).toBeNull();
  });

  it('names another collateral at LTV 0, such as a frozen one from Aave v3.6', () => {
    const frozen = account({ reserveLtvBps: new Map([[0, 8_000n], [2, 0n]]) });
    expect(ltvZeroBlocker(WETH, frozen)).toBe(CBBTC);
  });

  it('lets the LTV-0 asset itself leave first', () => {
    const frozen = account({ reserveLtvBps: new Map([[0, 8_000n], [2, 0n]]) });
    expect(ltvZeroBlocker(CBBTC, frozen)).toBeNull();
  });

  it('lets a frozen asset leave even when another one is frozen too', () => {
    const both = account({ reserveLtvBps: new Map([[0, 0n], [2, 0n]]) });
    expect(ltvZeroBlocker(WETH, both)).toBeNull();
  });

  it('ignores an LTV-0 reserve that is not enabled as collateral', () => {
    const notCollateral = account({
      userConfiguration: collateralBit(0) | borrowedBit(1) | borrowedBit(2),
      reserveLtvBps: new Map([[0, 8_000n]]),
    });
    expect(ltvZeroBlocker(WETH, notCollateral)).toBeNull();
  });

  it('finds nothing when the asset is not enabled as collateral, since Aave skips the check', () => {
    const disabled = account({
      userConfiguration: borrowedBit(1) | collateralBit(2),
      reserveLtvBps: new Map([[2, 0n]]),
    });
    expect(ltvZeroBlocker(WETH, disabled)).toBeNull();
  });

  it('finds nothing for an asset that is not a reserve', () => {
    expect(ltvZeroBlocker('0x4444444444444444444444444444444444444444', account())).toBeNull();
  });

  it('skips a dropped reserve left as a gap in the list', () => {
    const gap = account({
      reserves: [WETH, USDC, DROPPED],
      reserveLtvBps: new Map([[0, 8_000n], [2, 0n]]),
    });
    expect(ltvZeroBlocker(WETH, gap)).toBeNull();
  });
});

describe('userReserveLtv in eMode, as Aave getUserReserveLtv', () => {
  const eMode = (over: Partial<EModeTerms> = {}): EModeTerms => ({
    category: 1n,
    collateralBitmap: 1n << 0n,
    ltv: 9_000n,
    ltvzeroBitmap: 0n,
    isolated: false,
    ...over,
  });

  it('takes the category LTV for an asset that is collateral in it', () => {
    expect(userReserveLtv(0, account({ eMode: eMode() }))).toBe(9_000n);
  });

  it('takes the reserve LTV for an asset outside the category', () => {
    expect(userReserveLtv(2, account({ eMode: eMode() }))).toBe(7_300n);
  });

  it('is zero for an asset in the category ltvzero bitmap, Aave v3.7', () => {
    const zeroed = account({ eMode: eMode({ ltvzeroBitmap: 1n << 0n }) });
    expect(userReserveLtv(0, zeroed)).toBe(0n);
    // An LTV-0 WETH lets WETH leave, and blocks cbBTC.
    expect(ltvZeroBlocker(WETH, zeroed)).toBeNull();
    expect(ltvZeroBlocker(CBBTC, zeroed)).toBe(WETH);
  });

  it('is zero for every asset outside an isolated category, Aave v3.7', () => {
    const isolated = account({ eMode: eMode({ isolated: true }) });
    expect(userReserveLtv(2, isolated)).toBe(0n);
    expect(ltvZeroBlocker(WETH, isolated)).toBe(CBBTC);
  });

  it('uses the reserve LTVs outside eMode', () => {
    expect(userReserveLtv(0, account({ eMode: eMode({ category: 0n }) }))).toBe(8_000n);
  });
});
