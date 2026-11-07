import assert from "node:assert/strict";
import { test } from "node:test";
import { DRILL_TARGET, EXAMPLE_TERMS, ROUND_MS, buildDrill, hopsFor, keyFrames, totalMs, type DrillFrame, type DrillTerms } from "./drill.ts";
import { liquidate } from "./math.ts";

const near = (a: number, b: number, tolerance = 1e-6) => assert.ok(Math.abs(a - b) <= tolerance, `${a} against ${b}`);

/** The shape of the real position: about $36k of USDC against WBTC and WETH on Arbitrum. */
const real: DrillTerms = {
  source: "live",
  label: "Aave on Arbitrum",
  address: "0x175f2F6A1A70af8Ae33410E368D0FB8E85Ba7B05",
  blockNumber: "522067503",
  collateralUsd: 71_800,
  debtUsd: 36_463,
  liquidationThreshold: 0.8215,
  liquidationBonus: 0.05,
  usdcDebtUsd: 36_463,
  trigger: 1.2,
  target: 1.5,
};

const last = (frames: DrillFrame[]) => frames[frames.length - 1] as DrillFrame;

test("both branches last about twelve seconds", () => {
  const drill = buildDrill(real);
  for (const run of [drill.with, drill.without]) {
    assert.ok(totalMs(run) >= 10_000 && totalMs(run) <= 14_000, `${totalMs(run)} ms`);
  }
});

test("falling readings come every 160 ms and only ever fall", () => {
  const drill = buildDrill(real);
  const falling = drill.without.frames.filter((frame) => frame.phase === "falling");
  assert.ok(falling.length > 36);
  assert.ok(falling.every((frame) => frame.holdMs === ROUND_MS));
  falling.reduce((previous, frame) => {
    assert.ok(frame.health < previous.health);
    assert.equal(frame.round, previous.round + 1);
    return frame;
  });
});

test("the two branches share one path up to the trigger", () => {
  const drill = buildDrill(real);
  const shared = 37; // The reading and 36 rounds.
  assert.deepEqual(drill.with.frames.slice(0, shared), drill.without.frames.slice(0, shared));
});

test("with Levee, the water rises to the trigger and the repay reaches the target", () => {
  const { with: run } = buildDrill(real);
  const trigger = run.frames.find((frame) => frame.phase === "trigger") as DrillFrame;
  near(trigger.health, 1.2);
  const end = last(run.frames);
  assert.equal(end.phase, "repaid");
  near(end.health, DRILL_TARGET);
  near(end.debtUsd, real.debtUsd - run.repaidUsd);
  near(end.collateralUsd, trigger.collateralUsd); // No collateral moves.
  near(run.repaidUsd, real.debtUsd - (trigger.collateralUsd * real.liquidationThreshold) / DRILL_TARGET);
  assert.match(end.caption, /No collateral was sold/);
  assert.equal(end.hops, 3);
});

test("the repay cannot exceed USDC debt, so a thin USDC share falls short of the target", () => {
  const { with: run } = buildDrill({ ...real, usdcDebtUsd: 2000 });
  assert.equal(run.repaidUsd, 2000);
  assert.ok(last(run.frames).health < DRILL_TARGET);
});

test("without Levee, the first reading below 1.00 is liquidated on the position's terms", () => {
  const { without: run } = buildDrill(real);
  const flood = run.frames.find((frame) => frame.phase === "flood") as DrillFrame;
  assert.ok(flood.health < 1);
  assert.ok(flood.over);
  assert.ok(flood.health > 0.97); // It stops at the first reading past the line.
  const expected = liquidate({ collateralUsd: flood.collateralUsd, liquidationThreshold: real.liquidationThreshold, debtUsd: real.debtUsd }, real.liquidationBonus);
  assert.deepEqual(run.liquidation, expected);
  const end = last(run.frames);
  near(end.collateralUsd, expected.collateralLeftUsd);
  near(end.debtUsd, expected.debtLeftUsd);
  near(expected.bonusUsd, expected.repaidUsd * real.liquidationBonus);
  assert.match(end.caption, /bonus, paid by the borrower/);
});

test("a position already near the trigger still gets a fall", () => {
  const { with: run } = buildDrill({ ...real, collateralUsd: 53_000 }); // Health about 1.19.
  const trigger = run.frames.find((frame) => frame.phase === "trigger") as DrillFrame;
  assert.ok(trigger.health < 1.19 && trigger.health > 1);
  assert.ok(last(run.frames).health > trigger.health);
});

test("the marked example runs and says what it is", () => {
  const drill = buildDrill(EXAMPLE_TERMS);
  assert.match((drill.with.frames[0] as DrillFrame).caption, /^An example position\./);
  near(last(drill.with.frames).health, DRILL_TARGET);
});

test("no hop claims a time", () => {
  const drill = buildDrill(real);
  const hops = hopsFor("with", drill.with);
  assert.deepEqual(hops.map((hop) => hop.detail), ["not yet measured", "not yet measured", "not yet measured"]);
  for (const run of [drill.with, drill.without]) {
    for (const frame of run.frames) assert.doesNotMatch(frame.caption, /\d\s?(ms|s|seconds?)\b/);
  }
});

test("the table of states holds both endings", () => {
  const drill = buildDrill(real);
  assert.deepEqual(keyFrames(drill.with, "with").map((frame) => frame.phase), ["reading", "trigger", "repaid"]);
  assert.deepEqual(keyFrames(drill.without, "without").map((frame) => frame.phase), ["reading", "flood", "liquidated"]);
});
