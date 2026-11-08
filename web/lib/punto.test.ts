import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PUNTO_K, PUNTO_MAX, PUNTO_MIN, punto, tierFor } from "./punto.ts";

test("size is 2520 over distance in percent", () => {
  assert.equal(punto(42), 60);
  assert.equal(punto(100), 25.2);
  assert.ok(Math.abs(punto(12.13) - 207.75) < 0.01);
});

test("the rule is held between 15 and 208", () => {
  assert.equal(punto(1.2), PUNTO_MAX);
  assert.equal(punto(0), PUNTO_MAX);
  assert.equal(punto(-1), PUNTO_MAX);
  assert.equal(punto(622), PUNTO_MIN);
});

test("a row gets the label it has room for", () => {
  assert.equal(tierFor(12.1), "large");
  assert.equal(tierFor(42.9), "mid");
  assert.equal(tierFor(87.2), "small");
});

test("the stylesheet states the same rule", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, new RegExp(`--k:\\s*${PUNTO_K}\\b`));
  assert.match(css, new RegExp(`--size-min:\\s*${PUNTO_MIN}px`));
  assert.match(css, new RegExp(`--size-max:\\s*${PUNTO_MAX}px`));
});
