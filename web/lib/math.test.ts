import assert from "node:assert/strict";
import { test } from "node:test";
import { ADDRESS_ERRORS, parseAddress, shapeError } from "./address.ts";
import { percent, stageValue, usd } from "./format.ts";
import { BED_Y, CREST_Y, chartY, spreadLabels, staffTicks } from "./gauge.ts";
import { approxFall, healthAfterRepay, parseTarget, repayToTarget, stageForFall, stageForHealth } from "./math.ts";

const position = { collateralUsd: 1000, liquidationThreshold: 0.8, debtUsd: 600 };

test("approxFall follows 1 - 1/HF and stops at flood stage", () => {
  assert.equal(approxFall(2), 0.5);
  assert.ok(Math.abs(approxFall(1.25) - 0.2) < 1e-12);
  assert.equal(approxFall(1), 0);
  assert.equal(approxFall(0.9), 0);
});

test("repayToTarget reaches the target health factor exactly", () => {
  const repay = repayToTarget(position, 2);
  assert.equal(repay, 200); // 600 - 1000 * 0.8 / 2
  assert.equal(healthAfterRepay(position, repay), 2);
});

test("repayToTarget is zero above target and capped at the debt", () => {
  assert.equal(repayToTarget(position, 1.1), 0);
  assert.equal(repayToTarget({ ...position, collateralUsd: 0 }, 2), 600);
  assert.equal(repayToTarget({ ...position, debtUsd: 0 }, 2), 0);
});

test("stage bands", () => {
  assert.equal(stageForHealth(null), "dry");
  assert.equal(stageForHealth(0.99), "flood");
  assert.equal(stageForHealth(1), "action");
  assert.equal(stageForHealth(1.2499), "action");
  assert.equal(stageForHealth(1.25), "watch");
  assert.equal(stageForHealth(1.4999), "watch");
  assert.equal(stageForHealth(1.5), "normal");
  assert.equal(stageForFall(0), "flood");
  assert.equal(stageForFall(0.05), "action");
});

test("parseTarget accepts the allowed range and refuses the rest", () => {
  assert.equal(parseTarget(null), 1.5);
  assert.equal(parseTarget(""), 1.5);
  assert.equal(parseTarget("1.75"), 1.75);
  assert.equal(parseTarget("1"), null);
  assert.equal(parseTarget("99"), null);
  assert.equal(parseTarget("nope"), null);
});

test("parseAddress normalises and catches typos", () => {
  const checksummed = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
  assert.deepEqual(parseAddress(checksummed), { ok: true, address: checksummed });
  assert.deepEqual(parseAddress(`  ${checksummed.toLowerCase()} `), { ok: true, address: checksummed });
  assert.deepEqual(parseAddress(`0x${checksummed.slice(2).toUpperCase()}`), { ok: true, address: checksummed });
  assert.deepEqual(parseAddress(checksummed.replace("A238", "a238")), { ok: false, error: "checksum" });
  assert.deepEqual(parseAddress("0x123"), { ok: false, error: "shape" });
  assert.deepEqual(parseAddress(""), { ok: false, error: "empty" });
  assert.deepEqual(parseAddress("vitalik.eth"), { ok: false, error: "name" });
  assert.equal(shapeError("alice.near"), "name");
  assert.ok(ADDRESS_ERRORS.checksum.length > 0);
});

test("printed readings round down, not up", () => {
  assert.equal(stageValue(1.0999), "1.099");
  assert.equal(stageValue(0.99996), "0.999");
  assert.equal(percent(0.19999), "19.9%");
  assert.equal(usd(1234.56), "$1,235");
  assert.equal(usd(12.3), "$12.30");
  assert.equal(usd(-5), "-$5.00");
});

test("the staff runs from crest to bed in order", () => {
  assert.equal(chartY(0), CREST_Y);
  assert.equal(chartY(0.8), BED_Y);
  assert.equal(chartY(5), BED_Y);
  const ys = staffTicks().map((tick) => tick.y);
  assert.deepEqual([...ys].sort((a, b) => a - b), ys);
  assert.equal(staffTicks().filter((tick) => tick.stage).length, 8);
});

test("spreadLabels keeps labels apart without moving a lone label", () => {
  assert.deepEqual(spreadLabels([40], 6), [40]);
  assert.deepEqual(spreadLabels([40, 41], 6), [40, 46]);
  const [low, high] = spreadLabels([96, 95], 6);
  assert.ok(Math.abs((low as number) - (high as number)) >= 6);
  assert.ok((low as number) <= BED_Y);
});
