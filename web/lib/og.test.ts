import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ogAlt } from "./og.ts";
import { readProof } from "./proof-read.ts";

test("the link preview states the figures the run records give", () => {
  const alt = readFileSync(new URL("../app/opengraph-image.alt.txt", import.meta.url), "utf8");
  // When this fails, the runs changed: render the preview again with tools/og-image.ts.
  assert.equal(alt, ogAlt(readProof()));
});
