import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { evidenceDir, parseRun, readRuns } from "./evidence.ts";
import { CONTRACT_ID } from "./links.ts";
import { buildProof, hop, medianRun, monthName, plainReason, usdcAmount } from "./proof-model.ts";
import { readProof } from "./proof-read.ts";

const run = (id: string, total: number, parts: Record<string, unknown> = {}) =>
  parseRun(
    id,
    JSON.stringify({
      run_id: id,
      network: "testnet",
      position_id: 1,
      chain_id: 84532,
      amount: "7850000",
      outcome: "success",
      health_factor_before: "1.06",
      health_factor_after: "1.5",
      timestamps_ms: { detected: 1000, near_included: 2700, signed: 8000, broadcast: 8004, included: 1000 + total },
      near_tx: "HnynANQcgNunFpbmgAfeo8PMsytV8FMWr89zQ23AnukW",
      evm_tx: `0x${"ab".repeat(32)}`,
      evm_block: 55788984,
      near_contract: CONTRACT_ID,
      trace: { trigger: "1.20", target: "1.50", quorum: { samples: [{ total_collateral_base: "3346467387", total_debt_base: "2681143674", liquidation_threshold_bps: "8500" }] } },
      ...parts,
    }),
  );

test("the replayed run is the landed run at the median total", () => {
  const runs = [run("2026-11-07T19-00-00Z-a", 9000), run("2026-11-07T19-01-00Z-a", 8400), run("2026-11-07T19-02-00Z-a", 7300), run("2026-11-07T19-03-00Z-a", 0, { outcome: "aborted", timestamps_ms: { detected: 1000 } })];
  assert.equal(medianRun(runs)?.id, "2026-11-07T19-01-00Z-a");
  const proof = buildProof({ runs, signing: null, rehearsal: null, backtest: null });
  assert.equal(proof.replay?.id, "2026-11-07T19-01-00Z-a");
  assert.deepEqual(
    proof.runs.filter((entry) => entry.replayed).map((entry) => entry.id),
    ["2026-11-07T19-01-00Z-a"],
  );
});

test("the replay carries what the map draws, from the record", () => {
  const runs = [run("2026-11-07T19-00-00Z-a", 8000), run("2026-11-07T19-01-00Z-a", 8400), run("2026-11-07T19-02-00Z-a", 9000)];
  const replay = buildProof({ runs, signing: null, rehearsal: null, backtest: null }).replay;
  assert.ok(replay);
  assert.deepEqual(replay.marks, { near: 1700, signed: 7000, sent: 7004, included: 8400 });
  assert.equal(replay.amount, "7.85 USDC");
  assert.equal(replay.trigger, 1.2);
  assert.equal(replay.target, 1.5);
  assert.equal(replay.chain, "Base Sepolia");
  assert.equal(replay.evm.label, "Base tx");
  assert.match(replay.near.href, /^https:\/\/testnet\.nearblocks\.io\/txns\//);
  // The untimed fall starts where the run before it left health factor.
  assert.equal(replay.before?.from, 1.5);
  assert.ok(Math.abs((replay.before?.counted ?? 0) - 28.4449728) < 1e-6);
  assert.ok(Math.abs((replay.before?.debtAt ?? 0) - 26.81143674) < 1e-6);
});

test("no landed run means no replay", () => {
  assert.equal(buildProof({ runs: [run("x", 0, { outcome: "aborted" })], signing: null, rehearsal: null, backtest: null }).replay, null);
});

test("an aborted run keeps its reason, in words when the site knows it", () => {
  assert.equal(
    plainReason("quorum_disagreement: rescuerUsdc differs by more than 50 bps: a=1 b=2"),
    "Two RPCs disagreed on the reserve balance by more than 0.5%, so the keeper did nothing.",
  );
  assert.equal(plainReason("something new"), null);
  assert.equal(plainReason(null), null);
});

test("amounts and months print plainly", () => {
  assert.equal(usdcAmount("7857436"), "7.85 USDC");
  assert.equal(usdcAmount("1234500000"), "1,234.50 USDC");
  assert.equal(usdcAmount("0"), null);
  assert.equal(monthName("2025-10"), "October 2025");
  assert.equal(monthName("odd"), "odd");
});

test("the repository's runs give the figures the site states", () => {
  const proof = readProof();
  const landed = proof.runs.filter((entry) => entry.outcome === "success");
  assert.equal(proof.counts.success, landed.length);
  assert.equal(proof.overall.samples, landed.length);
  // The replayed run is a real landed run at exactly the median total.
  assert.ok(proof.replay);
  assert.equal(landed.find((entry) => entry.replayed)?.totalMs, proof.overall.p50Ms);
  assert.equal(proof.replay.marks.included, proof.overall.p50Ms);
  assert.ok((hop(proof, "near")?.p50Ms ?? 0) > 0);
  assert.ok((hop(proof, "mpc")?.p50Ms ?? 0) > (hop(proof, "near")?.p50Ms ?? 0));
});

test("every run record names the contract the site links to", () => {
  const dir = evidenceDir();
  for (const name of readdirSync(dir).filter((file) => file.endsWith(".json"))) {
    const record = JSON.parse(readFileSync(`${dir}/${name}`, "utf8")) as { near_contract?: string };
    assert.equal(record.near_contract, CONTRACT_ID, name);
  }
  assert.deepEqual(buildProof({ runs: readRuns(dir), signing: null, rehearsal: null, backtest: null }).contracts, [CONTRACT_ID]);
});
