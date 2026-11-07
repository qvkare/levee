import assert from "node:assert/strict";
import { test } from "node:test";
import { assessAssumption, bonusFromBps, bonusFromConfiguration, buildPosition, rayMul, repayFigure, type AccountData } from "./aave-model.ts";
import type { ReserveLine, Reserves } from "./types.ts";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const line = (symbol: string, usd: number, stable: boolean, asset = `0x${symbol}`): ReserveLine => ({ asset, symbol, amount: usd, usd, stable });
const reserves = (collateral: ReserveLine[], debt: ReserveLine[]): Reserves => ({ collateral, debt, eModeCategory: 0, liquidationBonus: 0.05 });

// Collateral $1,000, debt $600, threshold 80%, health factor 1.3333.
const account: AccountData = [100_000_000_000n, 60_000_000_000n, 15_000_000_000n, 8000n, 7500n, 1333333333333333333n];
const NO_DEBT = 2n ** 256n - 1n;
const BONUS_WETH_BASE = 0.05;

test("rayMul matches Aave rounding", () => {
  assert.equal(rayMul(10n ** 18n, 10n ** 27n), 10n ** 18n);
  assert.equal(rayMul(3n, 5n * 10n ** 26n), 2n); // 1.5 rounds up
});

test("the liquidation bonus comes out of the reserve's configuration word", () => {
  // WETH on Aave Base, read with Pool.getConfiguration on 2026-11-07: 10500 in bits 32 to 47.
  assert.equal(bonusFromConfiguration(7237005577332262213973186942896404178748954343157454914138546744326695690148n), BONUS_WETH_BASE);
  assert.equal(bonusFromConfiguration(10500n << 32n), 0.05);
  assert.equal(bonusFromBps(10100), 0.01);
  assert.equal(bonusFromBps(0), 0); // A reserve that cannot be used as collateral has no bonus.
});

test("no collateral and no debt is no position", () => {
  assert.equal(buildPosition([0n, 0n, 0n, 0n, 0n, NO_DEBT], null, USDC, 1.5), null);
});

test("collateral without debt is dry, with nothing to repay", () => {
  const position = buildPosition([100_000_000_000n, 0n, 0n, 8000n, 7500n, NO_DEBT], null, USDC, 1.5);
  assert.equal(position?.stage, "dry");
  assert.equal(position?.healthFactor, null);
  assert.equal(position?.dropToLiquidation, null);
  assert.equal(position?.repay, null);
});

test("a borrower gets stage, fall and repay from the account data", () => {
  const position = buildPosition(account, reserves([line("WETH", 1000, false)], [line("USDC", 600, true, USDC)]), USDC, 1.5);
  assert.ok(position);
  assert.equal(position.stage, "watch");
  assert.ok(Math.abs((position.healthFactor as number) - 1.3333) < 0.001);
  assert.equal(position.collateralUsd, 1000);
  assert.equal(position.liquidationThreshold, 0.8);
  assert.ok(Math.abs((position.dropToLiquidation?.fraction as number) - 0.25) < 0.001);
  assert.equal(position.dropToLiquidation?.assumptionHolds, true);
  assert.ok(Math.abs((position.repay?.usd as number) - 66.67) < 0.01); // 600 - 800 / 1.5
  assert.equal(position.raw.healthFactor, "1333333333333333333");
});

test("the 1 - 1/HF assumption is checked against what is held", () => {
  const stable = line("USDC", 600, true);
  assert.equal(assessAssumption(null).assumptionHolds, null);
  assert.deepEqual(assessAssumption(reserves([line("WETH", 1000, false)], [stable])), { assumptionHolds: true, note: null });

  const loop = assessAssumption(reserves([line("wstETH", 1000, false)], [line("WETH", 900, false)]));
  assert.equal(loop.assumptionHolds, false);
  assert.match(loop.note as string, /WETH/);

  const pegged = assessAssumption(reserves([line("USDC", 1000, true)], [stable]));
  assert.equal(pegged.assumptionHolds, false);
  assert.match(pegged.note as string, /depeg/);

  const mixed = assessAssumption(reserves([line("WETH", 800, false), line("GHO", 200, true)], [stable]));
  assert.equal(mixed.assumptionHolds, false);
  assert.match(mixed.note as string, /GHO/);
});

test("dust does not break the assumption", () => {
  const result = assessAssumption(reserves([line("WETH", 1000, false), line("GHO", 1, true)], [line("USDC", 600, true), line("cbBTC", 1, false)]));
  assert.equal(result.assumptionHolds, true);
});

test("repay reports what USDC debt can and cannot do", () => {
  const base = { collateralUsd: 1000, liquidationThreshold: 0.8, debtUsd: 600 };
  const none = repayFigure({ ...base, reserves: reserves([], [line("WETH", 600, false)]) }, USDC, 2);
  assert.equal(none.usd, 200);
  assert.equal(none.usdcDebtUsd, 0);
  assert.equal(none.usdcCovers, false);
  assert.equal(none.healthAfterAllUsdc, null);

  const some = repayFigure({ ...base, reserves: reserves([], [line("USDC", 100, true, USDC.toLowerCase()), line("WETH", 500, false)]) }, USDC, 2);
  assert.equal(some.usdcDebtUsd, 100);
  assert.equal(some.usdcCovers, false);
  assert.equal(some.healthAfterAllUsdc, 1.6); // 800 / 500

  const unread = repayFigure({ ...base, reserves: null }, USDC, 2);
  assert.equal(unread.usdcDebtUsd, null);
  assert.equal(unread.usdcCovers, null);
});
