import assert from "node:assert/strict";
import { test } from "node:test";
import { liquidate, simulateRescue } from "./math.ts";

const near = (a: number, b: number, tolerance = 1e-6) => assert.ok(Math.abs(a - b) <= tolerance, `${a} against ${b}`);

const position = { collateralUsd: 100_000, liquidationThreshold: 0.8, debtUsd: 50_000 }; // Health 1.6.
const settings = { trigger: 1.2, target: 1.5, reserveUsd: 20_000, liquidationBonus: 0.05 };

test("a liquidation takes the repaid value plus the bonus", () => {
  const result = liquidate({ collateralUsd: 60_000, liquidationThreshold: 0.8, debtUsd: 50_000 }, 0.05);
  near(result.repaidUsd, 25_000); // Half the debt: health 0.96 is above 0.95.
  near(result.takenUsd, 26_250);
  near(result.bonusUsd, 1250);
  near(result.collateralLeftUsd, 33_750);
  near(result.debtLeftUsd, 25_000);
  near(result.healthAfter as number, 1.08);
});

test("below 0.95 the whole debt can go", () => {
  const result = liquidate({ collateralUsd: 58_000, liquidationThreshold: 0.8, debtUsd: 50_000 }, 0.05);
  near(result.repaidUsd, 50_000);
  near(result.takenUsd, 52_500);
  near(result.debtLeftUsd, 0);
  assert.equal(result.healthAfter, null);
});

test("a small position can go whole, even above 0.95", () => {
  const result = liquidate({ collateralUsd: 1200, liquidationThreshold: 0.8, debtUsd: 1000 }, 0.05);
  near(result.repaidUsd, 1000);
});

test("a liquidator cannot take more collateral than is there", () => {
  const result = liquidate({ collateralUsd: 40_000, liquidationThreshold: 0.8, debtUsd: 50_000 }, 0.05);
  near(result.takenUsd, 40_000);
  near(result.repaidUsd, 40_000 / 1.05);
  near(result.collateralLeftUsd, 0);
  near(result.healthAfter as number, 0);
});

test("no fall: nothing fires", () => {
  const result = simulateRescue({ ...position, ...settings, fall: 0 });
  near(result.healthBefore as number, 1.6);
  assert.equal(result.triggered, false);
  assert.equal(result.repaidUsd, 0);
  near(result.healthAfter as number, 1.6);
  near(result.fallToTrigger as number, 0.25);
  near(result.fallToLiquidation as number, 0.375);
});

test("a fall past the trigger fires, and the repay reaches the target", () => {
  const result = simulateRescue({ ...position, ...settings, fall: 0.3 });
  near(result.healthAfterFall as number, 1.12);
  assert.equal(result.triggered, true);
  near(result.neededUsd, 50_000 - (70_000 * 0.8) / 1.5);
  near(result.repaidUsd, result.neededUsd);
  near(result.healthAfter as number, 1.5);
  near(result.reserveLeftUsd, 20_000 - result.neededUsd);
  assert.equal(result.liquidation, null);
});

test("a short reserve repays what it has and misses the target", () => {
  const result = simulateRescue({ ...position, ...settings, reserveUsd: 5000, fall: 0.3 });
  near(result.repaidUsd, 5000);
  near(result.reserveLeftUsd, 0);
  near(result.healthAfter as number, 56_000 / 45_000);
  assert.ok((result.healthAfter as number) < 1.5);
});

test("an empty reserve is the failure condition the site publishes", () => {
  const result = simulateRescue({ ...position, ...settings, reserveUsd: 0, fall: 0.5 });
  assert.equal(result.triggered, true);
  assert.equal(result.repaidUsd, 0);
  near(result.healthAfter as number, 0.8);
  assert.ok(result.liquidation);
  // Health 0.8 is below 0.95, so all of it could go, but only $50,000 of collateral is left to pay with.
  near(result.liquidation.repaidUsd, 50_000 / 1.05);
  near(result.liquidation.collateralLeftUsd, 0);
});

test("a rescue that lands but leaves health below 1.00 still gets liquidated", () => {
  const result = simulateRescue({ ...position, ...settings, reserveUsd: 2000, fall: 0.5 });
  near(result.repaidUsd, 2000);
  assert.ok(result.liquidation);
  near(result.liquidation.repaidUsd + result.liquidation.debtLeftUsd, 48_000);
});

test("no debt has no health and nothing to do", () => {
  const result = simulateRescue({ ...position, ...settings, debtUsd: 0, fall: 0.9 });
  assert.equal(result.healthBefore, null);
  assert.equal(result.triggered, false);
  assert.equal(result.healthAfter, null);
  assert.equal(result.fallToLiquidation, null);
});
