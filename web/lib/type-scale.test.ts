import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DISPLAY, HEADING, TYPE, fluid, fluidCss } from "./type-scale.ts";

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

test("the stylesheet states the same scale as the drawings", () => {
  assert.match(css, new RegExp(`--t-xs:\\s*${TYPE.xs}px;`));
  assert.match(css, new RegExp(`--t-s:\\s*${TYPE.s}px;`));
  assert.match(css, new RegExp(`--t-m:\\s*${TYPE.m}px;`));
  assert.match(css, new RegExp(`--t-l:\\s*${TYPE.l}px;`));
  assert.match(css, new RegExp(`--t-code:\\s*${TYPE.code}px;`));
  assert.ok(css.includes(`--t-xl: ${fluidCss(HEADING)};`));
  assert.ok(css.includes(`--t-xxl: ${fluidCss(DISPLAY)};`));
});

test("fluid sizes clamp as CSS does", () => {
  assert.equal(fluid(DISPLAY, 390), 38);
  assert.equal(fluid(DISPLAY, 1440), 58);
  assert.ok(Math.abs(fluid(DISPLAY, 1200) - 49.2) < 1e-9);
});
