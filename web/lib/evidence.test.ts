import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { evmLink, nearLink, parseRun, readRuns } from "./evidence.ts";

const success = {
  run_id: "2026-11-09T10-12-03Z-base-1",
  network: "mainnet",
  position_id: 1,
  chain_id: 8453,
  borrower: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
  rescuer: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
  amount: "2500000",
  outcome: "success",
  failure_reason: null,
  health_factor_before: "1.19",
  health_factor_after: "1.51",
  timestamps_ms: { detected: 1000, near_included: 2000, signed: 4000, broadcast: 4500, included: 6000 },
  near_tx: "6zgh2u9DqHHiXzdy9ouTP7oGky2T4nugqzqt9wJZwNFm",
  evm_tx: `0x${"ab".repeat(32)}`,
  evm_block: 123,
};

test("a run in the spec's shape is parsed in full", () => {
  const run = parseRun("file", JSON.stringify(success));
  assert.equal(run.id, success.run_id);
  assert.equal(run.outcome, "success");
  assert.equal(run.latencyMs, 5000);
  assert.equal(evmLink(run)?.href, `https://basescan.org/tx/${success.evm_tx}`);
  assert.equal(nearLink(run)?.href, `https://nearblocks.io/txns/${success.near_tx}`);
});

test("failures stay, with their reason", () => {
  const run = parseRun("file", JSON.stringify({ ...success, outcome: "failed", failure_reason: "liquidator won the race", evm_tx: null, timestamps_ms: {} }));
  assert.equal(run.outcome, "failed");
  assert.equal(run.failureReason, "liquidator won the race");
  assert.equal(run.latencyMs, null);
  assert.equal(evmLink(run), null);
});

test("a broken record is listed, not dropped", () => {
  assert.equal(parseRun("broken", "{ not json").outcome, "unreadable");
  assert.equal(parseRun("list", "[]").outcome, "unreadable");
  const noOutcome = parseRun("odd", JSON.stringify({ outcome: "great" }));
  assert.equal(noOutcome.outcome, "unreadable");
  assert.equal(noOutcome.id, "odd");
});

test("a testnet run links to testnet explorers", () => {
  const run = parseRun("file", JSON.stringify({ ...success, network: "testnet", chain_id: 84532 }));
  assert.match(evmLink(run)?.href as string, /^https:\/\/sepolia\.basescan\.org\/tx\//);
  assert.match(nearLink(run)?.href as string, /^https:\/\/testnet\.nearblocks\.io\/txns\//);
});

test("a malformed hash gets no link, and an unknown chain gets none", () => {
  assert.equal(evmLink(parseRun("file", JSON.stringify({ ...success, evm_tx: "0x123" }))), null);
  assert.equal(evmLink(parseRun("file", JSON.stringify({ ...success, chain_id: 1 }))), null);
  assert.equal(nearLink(parseRun("file", JSON.stringify({ ...success, near_tx: "javascript:alert(1)" }))), null);
});

test("runs are read from the folder, newest first, and a missing folder is empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "levee-runs-"));
  writeFileSync(join(dir, "2026-11-09T10-00-00Z-base-1.json"), JSON.stringify({ ...success, run_id: "2026-11-09T10-00-00Z-base-1" }));
  writeFileSync(join(dir, "2026-11-10T10-00-00Z-base-2.json"), JSON.stringify({ ...success, run_id: "2026-11-10T10-00-00Z-base-2", outcome: "failed" }));
  writeFileSync(join(dir, "notes.txt"), "ignored");
  const runs = readRuns(dir);
  assert.deepEqual(runs.map((run) => run.outcome), ["failed", "success"]);
  assert.deepEqual(readRuns(join(dir, "nothing-here")), []);
});
