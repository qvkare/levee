import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ACCOUNTS, KEY_DELETIONS, KEYLESS_RESCUE_NEAR_BLOCK, OWN, THIRD_PARTY, UNWIND } from "./contracts.ts";
import { readClaims } from "./evidence.ts";
import { integer } from "./format.ts";

const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

test("every contract and account the site lists is in the README, with the same link", () => {
  for (const row of [...OWN, ...ACCOUNTS, ...THIRD_PARTY]) {
    assert.ok(readme.includes(`[${row.address}](${row.href})`), row.address);
  }
  assert.ok(readme.includes(`repo.sourcify.dev/84532/${UNWIND}`));
});

test("the key deletions are the ones the claims ledger and the README state", () => {
  const claim = readClaims().find((entry) => entry.noAccessKeys.length > 0);
  assert.ok(claim);
  assert.deepEqual([...claim.noAccessKeys].sort(), KEY_DELETIONS.map((deletion) => deletion.account).sort());
  for (const deletion of KEY_DELETIONS) {
    assert.ok(claim.claim.includes(deletion.tx), deletion.tx);
    assert.ok(claim.claim.includes(integer(deletion.block)), String(deletion.block));
    assert.ok(readme.includes(`[tx](${deletion.href})`), deletion.href);
  }
  assert.ok(claim.claim.includes(integer(KEYLESS_RESCUE_NEAR_BLOCK)));
  assert.ok(KEY_DELETIONS.every((deletion) => deletion.block < KEYLESS_RESCUE_NEAR_BLOCK));
});
