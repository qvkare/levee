import assert from "node:assert/strict";
import { test } from "node:test";
import stored from "./fixtures/example-report.json" with { type: "json" };
import { fitsHome } from "./home-reading-rules.ts";
import { applyFall } from "./what-if.ts";
import { SCHEMA, type RiskReport } from "./types.ts";
import { buildWall } from "./wall.ts";

const example = stored as unknown as RiskReport;

test("the stored example is in the current schema and fills a wall", () => {
  assert.equal(example.schema, SCHEMA);
  assert.ok(buildWall(example).onAxis.length > 1);
  assert.equal(fitsHome(example), true);
});

test("a third party's position in its last 5% does not stand on the home page", () => {
  const fallen = applyFall(example, 0.111);
  assert.ok(fallen);
  assert.ok(buildWall(fallen.report).crisis);
  assert.equal(fitsHome(fallen.report), false);
});

test("an outage does not stand on the home page", () => {
  assert.equal(fitsHome({ ...example, status: "unavailable" }), false);
});
