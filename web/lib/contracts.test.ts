import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ACCOUNTS, KEY_DELETIONS, KEYLESS_RESCUE_NEAR_BLOCK, OWN, THIRD_PARTY, UNWIND, UNWIND_TWO_CHAINS } from "./contracts.ts";
import { readClaims } from "./evidence.ts";
import { integer } from "./format.ts";

const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

test("every contract and account the site lists is in the README, with the same link", () => {
  for (const row of [...OWN, ...ACCOUNTS, ...THIRD_PARTY]) {
    assert.ok(readme.includes(`[${row.address}](${row.href})`), row.address);
  }
  assert.ok(readme.includes(`repo.sourcify.dev/84532/${UNWIND}`));
  assert.ok(readme.includes(`repo.sourcify.dev/84532/${UNWIND_TWO_CHAINS}`));
  assert.ok(readme.includes(`repo.sourcify.dev/421614/${UNWIND_TWO_CHAINS}`));
});

test("the key deletions are the ones the claims ledger and the README state", () => {
  const claims = readClaims().filter((entry) => entry.noAccessKeys.length > 0);
  assert.ok(claims.length > 0);
  // Every account a claim says has no keys has its deletion here, and nothing else does.
  assert.deepEqual([...new Set(claims.flatMap((claim) => claim.noAccessKeys))].sort(), KEY_DELETIONS.map((deletion) => deletion.account).sort());
  for (const deletion of KEY_DELETIONS) {
    const claim = claims.find((entry) => entry.noAccessKeys.includes(deletion.account) && entry.claim.includes(deletion.tx));
    assert.ok(claim, deletion.tx);
    assert.ok(claim.claim.includes(integer(deletion.block)), String(deletion.block));
    assert.ok(readme.includes(`[tx](${deletion.href})`), deletion.href);
  }
  // The first keyless claim is the rescue the site walks through, after its accounts' deletions.
  const [first] = claims;
  assert.ok(first?.claim.includes(integer(KEYLESS_RESCUE_NEAR_BLOCK)));
  const its = KEY_DELETIONS.filter((deletion) => first?.noAccessKeys.includes(deletion.account));
  assert.ok(its.length > 0 && its.every((deletion) => deletion.block < KEYLESS_RESCUE_NEAR_BLOCK));
});
