import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { LEVEE_V1, LEVEE_V2, UNWIND } from "./contracts.ts";
import { evidenceDir, parseRun, readRuns, type Claim } from "./evidence.ts";
import { seconds } from "./format.ts";
import { buildProof, dayList, hop, medianRun, monthName, overall, plainReason, rangeName, tokenAmount, usdcAmount } from "./proof-model.ts";
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
      near_contract: LEVEE_V1,
      trace: { trigger: "1.20", target: "1.50", quorum: { samples: [{ total_collateral_base: "3346467387", total_debt_base: "2681143674", liquidation_threshold_bps: "8500" }] } },
      ...parts,
    }),
  );

/** A collateral run in the shape the keeper writes it (spec section 6). */
const unwind = (id: string, total: number, parts: Record<string, unknown> = {}) =>
  run(id, total, {
    near_contract: LEVEE_V2,
    health_factor_before: "1.48",
    health_factor_after: "1.803473",
    amount: "7306896",
    mode: "collateral",
    collateral: "0x4200000000000000000000000000000000000006",
    max_sold: "3304812972593412",
    sold: "3288371117008371",
    swap: { repaid: "7306896", sold: "3288371117008371", discount_bps: "50" },
    trace: { trigger: "1.5", target: "1.8", collateral: { helper: UNWIND }, quorum: { samples: [{ total_collateral_base: "3732239748", total_debt_base: "2143516012", liquidation_threshold_bps: "8500" }] } },
    ...parts,
  });

const none = { signing: null, rehearsal: null, reserveBacktest: null };

test("with no claim, the replayed run is the landed run at the median total", () => {
  const runs = [run("2026-11-07T19-00-00Z-a", 9000), run("2026-11-07T19-01-00Z-a", 8400), run("2026-11-07T19-02-00Z-a", 7300), run("2026-11-07T19-03-00Z-a", 0, { outcome: "aborted", timestamps_ms: { detected: 1000 } })];
  assert.equal(medianRun(runs)?.id, "2026-11-07T19-01-00Z-a");
  const proof = buildProof({ runs, ...none });
  assert.equal(proof.replay?.id, "2026-11-07T19-01-00Z-a");
  assert.equal(proof.replay?.chosen, "median");
  assert.deepEqual(
    proof.runs.filter((entry) => entry.replayed).map((entry) => entry.id),
    ["2026-11-07T19-01-00Z-a"],
  );
});

test("with no claim, a collateral run is replayed before a reserve run", () => {
  const runs = [run("2026-11-07T19-00-00Z-a", 8000), unwind("2026-11-08T10-00-00Z-a", 9000), unwind("2026-11-08T10-01-00Z-a", 7000), unwind("2026-11-08T10-02-00Z-a", 8000)];
  assert.equal(buildProof({ runs, ...none }).replay?.id, "2026-11-08T10-02-00Z-a");
});

test("the claim that the contracts have no keys picks the replayed run", () => {
  const runs = [unwind("2026-11-08T10-00-00Z-a", 8000), unwind("2026-11-08T10-01-00Z-a", 6600), unwind("2026-11-08T10-02-00Z-a", 9000)];
  const claims: Claim[] = [
    { id: "other", claim: "A run.", run: "2026-11-08T10-00-00Z-a", noAccessKeys: [] },
    { id: "keyless", claim: "No keys.", run: "2026-11-08T10-01-00Z-a", noAccessKeys: [LEVEE_V1, LEVEE_V2] },
  ];
  const proof = buildProof({ runs, claims, ...none });
  assert.equal(proof.replay?.id, "2026-11-08T10-01-00Z-a");
  assert.equal(proof.replay?.chosen, "keyless");
  assert.equal(proof.keyless?.claimId, "keyless");
  assert.deepEqual(proof.keyless?.deletions.map((deletion) => deletion.account).sort(), [LEVEE_V1, LEVEE_V2].sort());
  assert.deepEqual(
    proof.runs.filter((entry) => entry.keyless).map((entry) => entry.id),
    ["2026-11-08T10-01-00Z-a"],
  );
  // A claim that names a run not on file picks nothing.
  assert.equal(buildProof({ runs, claims: [{ id: "x", claim: "x", run: "missing", noAccessKeys: [LEVEE_V2] }], ...none }).replay?.chosen, "median");
});

test("the replay carries what the map draws, from the record", () => {
  const runs = [run("2026-11-07T19-00-00Z-a", 8000), run("2026-11-07T19-01-00Z-a", 8400), run("2026-11-07T19-02-00Z-a", 9000)];
  const replay = buildProof({ runs, ...none }).replay;
  assert.ok(replay);
  assert.deepEqual(replay.marks, { near: 1700, signed: 7000, sent: 7004, included: 8400 });
  assert.equal(replay.amount, "7.85 USDC");
  assert.equal(replay.trigger, 1.2);
  assert.equal(replay.target, 1.5);
  assert.equal(replay.chain, "Base Sepolia");
  assert.equal(replay.evm.label, "Base tx");
  assert.equal(replay.mode, "reserve");
  assert.equal(replay.sale, null);
  assert.match(replay.near.href, /^https:\/\/testnet\.nearblocks\.io\/txns\//);
  // The untimed fall starts where the run before it left health factor.
  assert.equal(replay.before?.from, 1.5);
  assert.ok(Math.abs((replay.before?.counted ?? 0) - 28.4449728) < 1e-6);
  assert.ok(Math.abs((replay.before?.debtAt ?? 0) - 26.81143674) < 1e-6);
});

test("a collateral run renders with its sale and its version", () => {
  const proof = buildProof({ runs: [unwind("2026-11-08T10-39-36Z-a", 6667)], ...none });
  const [entry] = proof.runs;
  assert.ok(entry);
  assert.equal(entry.mode, "collateral");
  assert.equal(entry.version, "v0.2");
  assert.equal(entry.amount, "7.31 USDC");
  assert.deepEqual(entry.sale, { symbol: "WETH", sold: "0.003288 WETH", maxSold: "0.003304 WETH", discountBps: 50 });
  assert.equal(proof.replay?.sale?.sold, "0.003288 WETH");
  assert.equal(proof.modes.collateral.counts.success, 1);
  assert.equal(proof.modes.reserve.counts.total, 0);
  assert.deepEqual(proof.modes.collateral.discount, { low: 50, high: 50 });
  assert.equal(proof.modes.collateral.trigger, 1.5);
});

test("each mode is timed on its own", () => {
  const runs = [run("2026-11-07T19-00-00Z-a", 8000), unwind("2026-11-08T10-00-00Z-a", 6000), unwind("2026-11-08T10-01-00Z-a", 7000)];
  const proof = buildProof({ runs, ...none });
  assert.equal(overall(proof, "collateral").samples, 2);
  assert.equal(overall(proof, "collateral").p50Ms, 6500);
  assert.equal(overall(proof, "reserve").p50Ms, 8000);
  assert.equal(hop(proof, "near", "reserve")?.p50Ms, 1700);
});

test("no landed run means no replay", () => {
  assert.equal(buildProof({ runs: [run("x", 0, { outcome: "aborted" })], ...none }).replay, null);
});

test("an aborted run keeps its reason, in words when the site knows it", () => {
  assert.equal(
    plainReason("quorum_disagreement: rescuerUsdc differs by more than 50 bps: a=1 b=2"),
    "Two RPCs disagreed on the reserve balance by more than 0.5%, so the keeper did nothing.",
  );
  assert.equal(
    plainReason("quote_over_slippage_bound: the pool asks 4127649486070153 for 9098767 USDC units, the helper allows 4112809988981552", "WETH"),
    "The pool asked 0.36% more WETH than the borrower’s price bound allows, so the keeper refused before asking NEAR, and nothing was sent.",
  );
  assert.equal(plainReason("something new"), null);
  assert.equal(plainReason(null), null);
});

test("amounts, days and months print plainly", () => {
  // To the nearest cent, as the spec's run table prints them.
  assert.equal(usdcAmount("7857436"), "7.86 USDC");
  assert.equal(usdcAmount("21867791"), "21.87 USDC");
  assert.equal(usdcAmount("9098766"), "9.10 USDC");
  assert.equal(usdcAmount("7306896"), "7.31 USDC");
  assert.equal(usdcAmount("1234500000"), "1,234.50 USDC");
  assert.equal(usdcAmount("4999"), "0.00 USDC");
  assert.equal(usdcAmount("0"), null);
  assert.equal(tokenAmount("3288371117008371", 18, "WETH"), "0.003288 WETH");
  assert.equal(tokenAmount("1500000000000000000", 18, "WETH"), "1.500000 WETH");
  assert.equal(tokenAmount(null, 18, "WETH"), null);
  assert.equal(monthName("2025-10"), "October 2025");
  assert.equal(monthName("odd"), "odd");
  assert.equal(rangeName("2025-10-10 to 2025-10-11"), "10 to 11 Oct 2025");
  assert.equal(rangeName("2026-01-31 to 2026-02-06"), "31 Jan to 6 Feb 2026");
  assert.equal(rangeName("2025-12-03 to 2026-01-01"), "3 Dec 2025 to 1 Jan 2026");
  assert.equal(dayList([Date.parse("2026-11-08T10:00:00Z"), Date.parse("2026-11-07T19:00:00Z")]), "7 and 8 Nov 2026");
  assert.equal(dayList([Date.parse("2026-11-08T10:00:00Z")]), "8 Nov 2026");
});

test("the repository's runs give the figures the site states", () => {
  const proof = readProof();
  const landed = proof.runs.filter((entry) => entry.outcome === "success");
  assert.equal(proof.counts.success, landed.length);
  assert.equal(proof.modes.collateral.counts.success + proof.modes.reserve.counts.success, landed.length);
  assert.equal(overall(proof, "collateral").samples, proof.modes.collateral.counts.success);
  // The replay is the rescue the claims ledger ties to the keyless contracts, a landed collateral run.
  assert.ok(proof.replay);
  assert.ok(proof.keyless);
  assert.equal(proof.replay.id, proof.keyless.run);
  assert.equal(proof.replay.chosen, "keyless");
  assert.equal(proof.replay.mode, "collateral");
  assert.equal(proof.replay.contract, LEVEE_V2);
  assert.ok(proof.replay.sale?.sold);
  assert.equal(landed.find((entry) => entry.replayed)?.id, proof.replay.id);
  // Every collateral rescue sold something and says how far from the oracle it sold.
  for (const entry of landed.filter((item) => item.mode === "collateral")) {
    assert.ok(entry.sale?.sold, entry.id);
    assert.equal(typeof entry.sale?.discountBps, "number", entry.id);
  }
  // Every aborted run is told in words.
  for (const entry of proof.runs.filter((item) => item.outcome === "aborted")) assert.ok(entry.why, entry.id);
  assert.ok((hop(proof, "near")?.p50Ms ?? 0) > 0);
  assert.ok((hop(proof, "mpc")?.p50Ms ?? 0) > (hop(proof, "near")?.p50Ms ?? 0));
  // The reading tool marks the backtest's trigger.
  assert.equal(proof.readingTrigger, proof.backtest?.trigger);
});

test("the hop table states the README's figures", () => {
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  const proof = readProof();
  const rows: Array<[string, "near" | "mpc" | "evm" | "overall"]> = [
    ["Detection to NEAR inclusion", "near"],
    ["NEAR inclusion to MPC signature", "mpc"],
    ["Broadcast to Base inclusion", "evm"],
    ["Total from detection", "overall"],
  ];
  for (const [label, id] of rows) {
    const line = readme.split("\n").find((entry) => entry.startsWith(`| ${label} |`));
    assert.ok(line, label);
    const cells = line.split("|").map((cell) => cell.trim()).filter(Boolean).slice(1);
    const figures = (["collateral", "reserve"] as const).flatMap((mode) => {
      const row = id === "overall" ? overall(proof, mode) : hop(proof, id, mode);
      return [seconds(row?.p50Ms ?? 0), seconds(row?.p95Ms ?? 0)];
    });
    assert.deepEqual(figures, cells, label);
  }
});

test("each collateral run states the spec's repay and price", () => {
  const spec = readFileSync(new URL("../../docs/SPEC.md", import.meta.url), "utf8");
  const proof = readProof();
  const rows = spec.split("\n").filter((line) => /^\| `\d{4}-\d{2}-\d{2}T[\d-]+Z-[\w-]+` \|/.test(line));
  assert.ok(rows.length > 0);
  for (const row of rows) {
    const cells = row.split("|").map((cell) => cell.trim()).filter(Boolean);
    const id = (cells[0] as string).replaceAll("`", "");
    const entry = proof.runs.find((item) => item.id === id);
    assert.ok(entry, id);
    if (entry.outcome !== "success") continue;
    assert.equal(entry.amount, `${cells[3]} USDC`, id);
    assert.equal(`${entry.sale?.discountBps} bps below`, cells[5], id);
  }
});

test("every run record names one of the site's contracts, by mode", () => {
  const dir = evidenceDir();
  for (const name of readdirSync(dir).filter((file) => file.endsWith(".json"))) {
    const record = JSON.parse(readFileSync(`${dir}/${name}`, "utf8")) as { near_contract?: string; mode?: string; trace?: { collateral?: { helper?: string } } };
    assert.equal(record.near_contract, record.mode === "collateral" ? LEVEE_V2 : LEVEE_V1, name);
    if (record.mode === "collateral") assert.equal(record.trace?.collateral?.helper, UNWIND, name);
  }
  assert.deepEqual(buildProof({ runs: readRuns(dir), ...none }).contracts.sort(), [LEVEE_V1, LEVEE_V2].sort());
});
