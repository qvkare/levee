import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { evidenceDir, evmLink, latencyTable, median, nearLink, parseClaims, parseMpcLatency, parseRun, percentile, readClaims, readMpcLatency, readRehearsal, readRuns, tally } from "./evidence.ts";

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

test("a collateral run is parsed with its sale, and a record with no mode is a reserve run", () => {
  const collateral = parseRun(
    "file",
    JSON.stringify({
      ...success,
      mode: "collateral",
      collateral: "0x4200000000000000000000000000000000000006",
      max_sold: "3304812972593412",
      sold: "3288371117008371",
      swap: { repaid: "7306896", sold: "3288371117008371", collateral_price_base: "223286000000", usdc_price_base: "99977300", effective_price_base: "222153676536", discount_bps: "50" },
      trace: { trigger: "1.5", target: "1.8", collateral: { asset: "0x4200000000000000000000000000000000000006", helper: "0x308a7b2872F6006522280026a750fCD1c5Bd63D2", pool_fee: "3000" } },
    }),
  );
  assert.equal(collateral.mode, "collateral");
  assert.equal(collateral.collateral, "0x4200000000000000000000000000000000000006");
  assert.equal(collateral.maxSold, "3304812972593412");
  assert.equal(collateral.sold, "3288371117008371");
  assert.deepEqual(collateral.swap, { repaid: "7306896", sold: "3288371117008371", discountBps: 50 });
  assert.equal(collateral.trace?.helper, "0x308a7b2872F6006522280026a750fCD1c5Bd63D2");
  const reserve = parseRun("file", JSON.stringify(success));
  assert.equal(reserve.mode, "reserve");
  assert.equal(reserve.swap, null);
  // An aborted collateral run keeps nulls where it sold nothing.
  const aborted = parseRun("file", JSON.stringify({ ...success, outcome: "aborted", mode: "collateral", max_sold: null, sold: null, swap: null }));
  assert.equal(aborted.sold, null);
  assert.equal(aborted.swap, null);
});

test("the claims ledger is read, with the accounts that must have no keys", () => {
  const claims = parseClaims(JSON.stringify({ claims: [{ id: "a", claim: "A test.", test: { path: "p", name: "n" } }, { id: "b", claim: "No keys.", run: "r", no_access_keys: ["x.testnet", 3] }, { claim: "no id" }] }));
  assert.deepEqual(claims, [
    { id: "a", claim: "A test.", run: null, noAccessKeys: [] },
    { id: "b", claim: "No keys.", run: "r", noAccessKeys: ["x.testnet"] },
  ]);
  assert.deepEqual(parseClaims("nope"), []);
  assert.ok(readClaims().some((claim) => claim.noAccessKeys.length > 0));
});

test("a median is the middle value, or the mean of the two middle values", () => {
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test("percentiles are nearest rank, so a small sample's p95 is its slowest", () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([3, 1, 2], 0.5), 2);
  assert.equal(percentile([4, 1, 3, 2], 0.5), 2);
  assert.equal(percentile(Array.from({ length: 13 }, (_, i) => i + 1), 0.95), 13);
  assert.equal(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 0.95), 95);
});

test("hops are timed from the keeper's timestamps", () => {
  const { hops, overall } = latencyTable([parseRun("a", JSON.stringify(success))]);
  assert.deepEqual(hops.map((hop) => hop.p50Ms), [1000, 2000, 500, 1500]);
  assert.equal(overall.p50Ms, 5000);
  assert.equal(overall.samples, 1);
});

test("a run that stopped early counts only for the hops it finished", () => {
  const aborted = parseRun("b", JSON.stringify({ ...success, outcome: "aborted", timestamps_ms: { detected: 1000, near_included: null } }));
  const { hops, overall } = latencyTable([aborted]);
  assert.ok(hops.every((hop) => hop.samples === 0 && hop.p50Ms === null));
  assert.equal(overall.samples, 0);
});

test("the tally counts what is in the folder", () => {
  const runs = [parseRun("a", JSON.stringify({ ...success, network: "testnet", chain_id: 84532 })), parseRun("b", JSON.stringify({ ...success, network: "testnet", chain_id: 84532, outcome: "aborted" }))];
  assert.deepEqual(tally(runs), { total: 2, success: 1, failed: 0, aborted: 1, unreadable: 0, chains: ["Base Sepolia"], positions: 1, testnetOnly: true });
  assert.equal(tally([parseRun("a", JSON.stringify(success))]).testnetOnly, false);
});

test("signing figures are worked out from the samples", () => {
  const raw = JSON.stringify({ network: "testnet", mpc: "m", measured_at: "t", note: "n", p50_ms: 1, samples: [{ run: 0, outcome: "signed", elapsed_ms: 6000 }, { run: 1, outcome: "signed", elapsed_ms: 7000 }, { run: 2, outcome: "failed", elapsed_ms: 9000 }] });
  const parsed = parseMpcLatency(raw);
  assert.equal(parsed?.runs, 3);
  assert.equal(parsed?.signed, 2);
  assert.equal(parsed?.failed, 1);
  assert.equal(parsed?.p50Ms, 6500);
  assert.equal(parsed?.slowestMs, 7000);
  assert.equal(parseMpcLatency("nope"), null);
});

test("the repository's records add up", () => {
  const runs = readRuns(evidenceDir());
  const counts = tally(runs);
  assert.equal(counts.total, counts.success + counts.failed + counts.aborted + counts.unreadable);
  assert.ok(counts.total > 0);
  const { overall } = latencyTable(runs);
  assert.equal(overall.samples, counts.success);
  assert.ok((overall.p50Ms as number) <= (overall.p95Ms as number));
});

test("the measured signing figures match the file's own summary", () => {
  const latency = readMpcLatency();
  const file = JSON.parse(readFileSync(`${evidenceDir()}/../mpc-latency-testnet.json`, "utf8")) as { runs: number; signed: number; p50_ms: number; p95_ms: number; max_ms: number };
  assert.equal(latency?.runs, file.runs);
  assert.equal(latency?.signed, file.signed);
  assert.equal(latency?.p50Ms, file.p50_ms);
  assert.equal(latency?.p95Ms, file.p95_ms);
  assert.equal(latency?.slowestMs, file.max_ms);
});

test("the rehearsal is only read if the file says it was a fork", () => {
  const rehearsal = readRehearsal();
  assert.match(rehearsal?.label as string, /fork/);
  const dir = mkdtempSync(join(tmpdir(), "levee-rehearsal-"));
  mkdirSync(join(dir, "rehearsal"));
  writeFileSync(join(dir, "rehearsal", "base-sepolia-fork-rescue.json"), JSON.stringify({ ...success, label: "A live run" }));
  assert.equal(readRehearsal(dir), null);
});
