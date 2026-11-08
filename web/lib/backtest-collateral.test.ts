import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { collateralBacktestPath, headlineRow, readCollateralBacktest } from "./backtest-collateral.ts";
import { integer } from "./format.ts";
import { buildProof, type BoundFigures, type CollateralFigures } from "./proof-model.ts";

const file = readCollateralBacktest();
const figures = file ? (buildProof({ runs: [], signing: null, rehearsal: null, reserveBacktest: null, backtest: file }).backtest as CollateralFigures) : null;
const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

/** Whole thousands, as the README rounds them: $181k, +$83k, −$122k. */
const k = (value: number, signed = false) => `${value < 0 ? "−" : signed ? "+" : ""}$${Math.round(Math.abs(value) / 1000)}k`;
const tight = (period: CollateralFigures["periods"][number]) => period.bounds[0] as BoundFigures;

test("the collateral backtest is read, and a missing file is not a crash", () => {
  assert.ok(file);
  assert.ok(figures);
  assert.equal(readCollateralBacktest(`${collateralBacktestPath()}.missing`), null);
  assert.deepEqual(figures.bounds, [100, 300]);
  assert.deepEqual(figures.chains, ["Base", "Arbitrum"]);
  assert.equal(figures.periods.length, 3);
  assert.equal(figures.periods.filter((period) => period.calm).length, 1);
});

test("every liquidated member is saved or missed for a named reason", () => {
  assert.ok(file && figures);
  for (const period of figures.periods) {
    for (const bound of period.bounds) {
      const row = headlineRow(file, period.key, bound.bps);
      assert.ok(row);
      const reasons = Object.values(row.reasons).reduce((total, count) => total + count, 0);
      assert.equal(reasons, row.liquidated, `${period.key} ${bound.bps}`);
      assert.equal(bound.misses.reduce((total, miss) => total + miss.count, 0), row.liquidated - row.saved);
      assert.ok(bound.misses.every((miss) => miss.name.length > 0));
    }
  }
});

test("the table states the README's backtest figures", () => {
  assert.ok(figures);
  const lines = readme.split("\n").filter((line) => /^\| \d{4}-\d{2}-\d{2} to /.test(line));
  assert.equal(lines.length, figures.periods.length);
  figures.periods.forEach((period, index) => {
    const cells = (lines[index] as string).split("|").map((cell) => cell.trim()).filter(Boolean);
    assert.equal(cells[1], integer(period.members), period.key);
    assert.equal(cells[2], integer(period.liquidated), period.key);
    assert.equal(cells[3], period.bounds.map((bound) => integer(bound.saved)).join(" / "), period.key);
    assert.equal(cells[4], `${integer(period.reserve.saved)} / ${integer(period.upfront.saved)}`, period.key);
    assert.equal(cells[9], period.bounds.map((bound) => k(bound.net, true)).join(" / "), period.key);
  });
});

test("the caveats' figures are the README's", () => {
  assert.ok(figures);
  const [first] = figures.periods;
  assert.ok(first);
  const bound = tight(first);
  assert.ok(readme.includes(`${bound.savedArmedBelow} of ${bound.saved} in 2025-10`));
  assert.ok(readme.includes(`it is ${k(bound.swapCostNoBetter)} and the net is ${k(bound.netNoBetter, true)}`));
  assert.ok(readme.includes(`${Math.round((bound.gasReverted / bound.gas) * 100)}% of it went on reverted unwinds`));
  assert.ok(readme.includes(`the 2025-10 net would be ${k(bound.netNoReverts, true)}`));
  const calm = figures.periods.find((period) => period.calm);
  assert.ok(calm);
  assert.ok(readme.includes(`it cost $${tight(calm).perMemberAbove.toFixed(2)} per borrower armed above the trigger over ${calm.days} days, and sold ${(tight(calm).soldShareAbove * 100).toFixed(1)}% of their collateral`));
  const size = figures.sizes.find((row) => row.period === first.key && row.bps === bound.bps);
  assert.ok(size);
  assert.ok(readme.includes(`it lost ${k(-size.smallNet)} on positions under $10k of debt, mostly to gas, and made ${k(size.largeNet)} on larger ones`));
  assert.ok(size.smallGas > -size.smallNet, "mostly to gas");
});
