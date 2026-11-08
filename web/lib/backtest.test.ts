import assert from "node:assert/strict";
import { test } from "node:test";
import { MISS_MEANINGS, backtestPath, honestFigures, readBacktest, type MissReason } from "./backtest.ts";

const summary = readBacktest();

test("the summary is read, and a missing file is not a crash", () => {
  assert.ok(summary);
  assert.equal(readBacktest(`${backtestPath()}.missing`), null);
});

test("every position in the headline cell is accounted for", () => {
  assert.ok(summary);
  const { cell } = summary.headline;
  assert.equal(cell.saved + cell.notSaved, cell.positions);
  const reasons = Object.values(cell.reasons).reduce((total, count) => total + count, 0);
  assert.equal(reasons, cell.positions);
});

test("each way of missing has a meaning", () => {
  assert.ok(summary);
  const reasons = Object.keys(summary.headline.cell.reasons).filter((reason) => reason !== "saved") as MissReason[];
  assert.ok(reasons.every((reason) => MISS_MEANINGS[reason]));
});

test("the race is told apart from repays that fired at arming", () => {
  assert.ok(summary);
  const honest = honestFigures(summary);
  const { cell } = summary.headline;
  assert.equal(honest.armedBelow + honest.armedAbove, cell.positions);
  assert.ok(honest.savedArmedAbove <= honest.armedAbove);
});

test("the cases where Levee is no better are found, not assumed", () => {
  assert.ok(summary);
  const honest = honestFigures(summary);
  assert.ok(honest.collateralAtLeastAsGood.every((row) => row.holdAsCollateral >= row.levee));
  assert.equal(honest.repayAtArmingNeverWorse, summary.fair.every((row) => row.repayAtArming >= row.levee));
  assert.equal(honest.bothSurvive, summary.headline.fair.both);
});
