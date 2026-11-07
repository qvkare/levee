import assert from "node:assert/strict";
import { test } from "node:test";
import { clientKey, fixedWindow } from "./limit.ts";

test("a key is refused past the limit, and a new window lets it back in", () => {
  let time = 0;
  const allow = fixedWindow(2, 1000, 10, () => time);
  assert.equal(allow("a"), true);
  assert.equal(allow("a"), true);
  assert.equal(allow("a"), false);
  assert.equal(allow("b"), true);
  time = 1000;
  assert.equal(allow("a"), true);
});

test("the table stays bounded", () => {
  let time = 0;
  const allow = fixedWindow(1, 1000, 2, () => time);
  allow("a");
  allow("b");
  allow("c");
  // "a" was dropped to make room, so it starts again. "c" was kept.
  assert.equal(allow("a"), true);
  assert.equal(allow("c"), false);
  time = 1;
});

test("Cloudflare's address wins over one the client can set", () => {
  const headers = (entries: Record<string, string>) => new Headers(entries);
  assert.equal(clientKey(headers({ "cf-connecting-ip": "1.1.1.1", "x-forwarded-for": "2.2.2.2" })), "1.1.1.1");
  assert.equal(clientKey(headers({ "x-forwarded-for": "2.2.2.2, 3.3.3.3" })), "2.2.2.2");
  assert.equal(clientKey(headers({})), "local");
});
