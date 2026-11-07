import assert from "node:assert/strict";
import { test } from "node:test";
import { ttlCache } from "./cache.ts";

test("serves a fresh value and reloads after it expires", async () => {
  let clock = 0;
  let loads = 0;
  const cache = ttlCache<number>(() => 100, 10, () => clock);
  const load = async () => ++loads;
  assert.equal(await cache.get("a", load), 1);
  clock = 99;
  assert.equal(await cache.get("a", load), 1);
  clock = 100;
  assert.equal(await cache.get("a", load), 2);
});

test("concurrent reads share one load", async () => {
  let loads = 0;
  const cache = ttlCache<number>(() => 100, 10);
  const load = async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return ++loads;
  };
  assert.deepEqual(await Promise.all([cache.get("a", load), cache.get("a", load)]), [1, 1]);
});

test("a zero lifetime is not stored", async () => {
  let loads = 0;
  const cache = ttlCache<number>(() => 0, 10);
  await cache.get("a", async () => ++loads);
  await cache.get("a", async () => ++loads);
  assert.equal(loads, 2);
});

test("a failed load is not stored and leaves nothing pending", async () => {
  const cache = ttlCache<number>(() => 100, 10);
  await assert.rejects(cache.get("a", async () => Promise.reject(new Error("boom"))));
  assert.equal(await cache.get("a", async () => 7), 7);
});

test("the oldest entry goes first when full", async () => {
  let loads = 0;
  const cache = ttlCache<number>(() => 1000, 2);
  const load = async () => ++loads;
  await cache.get("a", load);
  await cache.get("b", load);
  await cache.get("c", load);
  assert.equal(await cache.get("c", load), 3);
  assert.equal(await cache.get("a", load), 4);
});
