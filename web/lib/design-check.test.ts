import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const TOOL = new URL("../tools/design-check.mjs", import.meta.url).pathname;

/** Runs design-check on files written to a fresh folder, with DESIGN.md allowing `max` sizes. */
function check(files: Record<string, string>, max = 7) {
  const dir = mkdtempSync(join(tmpdir(), "levee-design-"));
  writeFileSync(join(dir, "DESIGN.md"), `<!-- design-check: max-type-sizes ${max} -->\n`);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const run = spawnSync(process.execPath, [TOOL, dir, "--json"], { cwd: dir, encoding: "utf8" });
  return { status: run.status, rules: (JSON.parse(run.stdout) as Array<{ rule: string }>).map((finding) => finding.rule) };
}

const scale = (count: number) => `:root {\n${Array.from({ length: count }, (_, index) => `  --t-${index}: ${12 + index}px;`).join("\n")}\n}\n`;

test("the scale DESIGN.md allows passes", () => {
  const result = check({ "a.css": `${scale(7)}.x {\n  font-size: var(--t-0);\n}\n` });
  assert.deepEqual(result.rules, []);
  assert.equal(result.status, 0);
});

test("one size more than DESIGN.md allows fails", () => {
  const result = check({ "a.css": scale(8) });
  assert.deepEqual(result.rules, ["type-scale"]);
  assert.equal(result.status, 1);
});

test("a token redefined in a media query counts each size", () => {
  const result = check({ "a.css": `${scale(6)}@media (max-width: 820px) {\n  :root {\n    --t-0: 11px;\n    --t-1: 10px;\n  }\n}\n` });
  assert.deepEqual(result.rules, ["type-scale"]);
});

test("a literal size, a shorthand size and a size in a component fail", () => {
  const result = check({ "a.css": `${scale(2)}.x {\n  font-size: 14px;\n}\n.y {\n  font: 800 17px/1 sans-serif;\n}\n`, "b.tsx": "export const B = () => <text fontSize={12}>x</text>;\n" });
  assert.deepEqual(result.rules.sort(), ["font-shorthand", "inline-size", "literal-size"]);
});

test("copy rules: a heading with a full stop and an X, not Y turn", () => {
  const result = check({ "c.tsx": 'export const C = () => (\n  <>\n    <h2 className="big">\n      Who can do what.\n    </h2>\n    <p>Its figures are missing, not zero.</p>\n  </>\n);\n' });
  assert.deepEqual(result.rules.sort(), ["heading-stop", "x-not-y"]);
});

test("amber and literal colours stay in the tokens", () => {
  // design-allow: the fixture has to hold the colour the check looks for
  const result = check({ "d.css": ":root {\n  --amber: #f2a100;\n}\n.x {\n  color: #F2A100;\n}\n", "e.tsx": 'export const E = () => <rect fill="#1f4fd6" />;\n' });
  assert.deepEqual(result.rules.sort(), ["amber-token", "literal-colour"]);
});
