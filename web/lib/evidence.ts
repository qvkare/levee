/**
 * Reads evidence/runs/*.json at build time (spec section 6), and the claims ledger. A record that
 * cannot be parsed is listed as unreadable and not dropped, because failed runs stay visible.
 *
 * Only prerendered pages may call readRuns. A Worker has no evidence folder at runtime, and a page
 * rendered there would report no runs whatever had happened.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname } from "node:path";

export type Outcome = "success" | "failed" | "aborted" | "unreadable";

/** How a run repaid: by selling the borrower's collateral, or from USDC held at the rescuer. */
export type Mode = "collateral" | "reserve";

/** Each moment of a run, in milliseconds. Null when the run did not get there. */
export interface Timestamps {
  detected: number | null;
  nearIncluded: number | null;
  signed: number | null;
  broadcast: number | null;
  included: number | null;
}

/** The sale's effective price against Aave's oracle at that block, from the Unwound event. */
export interface Swap {
  /** USDC base units. */
  repaid: string | null;
  /** Collateral base units. */
  sold: string | null;
  /** How far under the oracle the sale was, the pool fee included. */
  discountBps: number | null;
}

export interface EvidenceRun {
  id: string;
  outcome: Outcome;
  network: string | null;
  chainId: number | null;
  positionId: number | null;
  borrower: string | null;
  rescuer: string | null;
  /** USDC base units, as recorded. */
  amount: string | null;
  failureReason: string | null;
  healthBefore: string | null;
  healthAfter: string | null;
  /** Milliseconds from detection to inclusion, when both are recorded. */
  latencyMs: number | null;
  timestamps: Timestamps;
  nearTx: string | null;
  evmTx: string | null;
  evmBlock: number | null;
  /** The Levee contract the keeper called. */
  nearContract: string | null;
  /** A record with no mode is a reserve run (spec section 6). */
  mode: Mode;
  /** The collateral's address, for a collateral run. */
  collateral: string | null;
  /** The keeper's cap on the sale, in collateral base units. */
  maxSold: string | null;
  /** What the helper sold, in collateral base units. */
  sold: string | null;
  swap: Swap | null;
  trace: RunTrace | null;
}

/**
 * The few trace figures the site draws: the keeper's settings, and what the first RPC read at
 * detection. Aave base-currency values have 8 decimals of USD. Strings, as recorded.
 */
export interface RunTrace {
  trigger: string | null;
  target: string | null;
  collateralBase: string | null;
  debtBase: string | null;
  thresholdBps: string | null;
  /** The helper the keeper called, for a collateral run. */
  helper: string | null;
}

const OUTCOMES: readonly string[] = ["success", "failed", "aborted"];

const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

const NO_TIMESTAMPS: Timestamps = { detected: null, nearIncluded: null, signed: null, broadcast: null, included: null };

function timestampsOf(raw: unknown): Timestamps {
  if (typeof raw !== "object" || raw === null) return NO_TIMESTAMPS;
  const { detected, near_included, signed, broadcast, included } = raw as Record<string, unknown>;
  return { detected: count(detected), nearIncluded: count(near_included), signed: count(signed), broadcast: count(broadcast), included: count(included) };
}

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

function traceOf(raw: unknown): RunTrace | null {
  if (typeof raw !== "object" || raw === null) return null;
  const trace = record(raw);
  const samples = record(trace.quorum).samples;
  const first = record(Array.isArray(samples) ? samples[0] : null);
  return {
    trigger: text(trace.trigger),
    target: text(trace.target),
    collateralBase: text(first.total_collateral_base),
    debtBase: text(first.total_debt_base),
    thresholdBps: text(first.liquidation_threshold_bps),
    helper: text(record(trace.collateral).helper),
  };
}

function swapOf(raw: unknown): Swap | null {
  if (typeof raw !== "object" || raw === null) return null;
  const swap = record(raw);
  const discount = text(swap.discount_bps);
  return { repaid: text(swap.repaid), sold: text(swap.sold), discountBps: discount !== null && /^-?\d+(\.\d+)?$/.test(discount) ? Number(discount) : null };
}

function latency({ detected, included }: Timestamps): number | null {
  return detected && included && included >= detected ? included - detected : null;
}

export function parseRun(id: string, raw: string): EvidenceRun {
  const unreadable: EvidenceRun = {
    id,
    outcome: "unreadable",
    network: null,
    chainId: null,
    positionId: null,
    borrower: null,
    rescuer: null,
    amount: null,
    failureReason: "This record could not be read.",
    healthBefore: null,
    healthAfter: null,
    latencyMs: null,
    timestamps: NO_TIMESTAMPS,
    nearTx: null,
    evmTx: null,
    evmBlock: null,
    nearContract: null,
    mode: "reserve",
    collateral: null,
    maxSold: null,
    sold: null,
    swap: null,
    trace: null,
  };
  let fields: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return unreadable;
    fields = parsed as Record<string, unknown>;
  } catch {
    return unreadable;
  }
  const outcome = text(fields.outcome);
  if (!outcome || !OUTCOMES.includes(outcome)) return { ...unreadable, failureReason: "This record has no valid outcome." };
  const timestamps = timestampsOf(fields.timestamps_ms);
  return {
    id: text(fields.run_id) ?? id,
    outcome: outcome as Outcome,
    network: text(fields.network),
    chainId: count(fields.chain_id),
    positionId: count(fields.position_id),
    borrower: text(fields.borrower),
    rescuer: text(fields.rescuer),
    amount: text(fields.amount),
    failureReason: text(fields.failure_reason),
    healthBefore: text(fields.health_factor_before),
    healthAfter: text(fields.health_factor_after),
    latencyMs: latency(timestamps),
    timestamps,
    nearTx: text(fields.near_tx),
    evmTx: text(fields.evm_tx),
    evmBlock: count(fields.evm_block),
    nearContract: text(fields.near_contract),
    mode: fields.mode === "collateral" ? "collateral" : "reserve",
    collateral: text(fields.collateral),
    maxSold: text(fields.max_sold),
    sold: text(fields.sold),
    swap: swapOf(fields.swap),
    trace: traceOf(fields.trace),
  };
}

/** The repository's evidence folder. `next build` runs from web/, so it is one level up. */
export function evidenceDir(): string {
  return process.env.LEVEE_EVIDENCE_DIR || `${process.cwd()}/../evidence/runs`;
}

/** Newest first: run ids start with a timestamp. */
export function readRuns(dir: string = evidenceDir()): EvidenceRun[] {
  if (!existsSync(/* turbopackIgnore: true */ dir)) return [];
  return readdirSync(/* turbopackIgnore: true */ dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => parseRun(name.replace(/\.json$/, ""), readFileSync(/* turbopackIgnore: true */ `${dir}/${name}`, "utf8")))
    .sort((a, b) => b.id.localeCompare(a.id));
}

const EVM_EXPLORERS: Record<number, { name: string; url: string }> = {
  8453: { name: "Basescan", url: "https://basescan.org" },
  42161: { name: "Arbiscan", url: "https://arbiscan.io" },
  84532: { name: "Basescan Sepolia", url: "https://sepolia.basescan.org" },
  421614: { name: "Arbiscan Sepolia", url: "https://sepolia.arbiscan.io" },
};

export const CHAIN_NAMES: Record<number, string> = {
  8453: "Base",
  42161: "Arbitrum",
  84532: "Base Sepolia",
  421614: "Arbitrum Sepolia",
};

export function evmLink(run: EvidenceRun): { href: string; label: string } | null {
  const explorer = run.chainId === null ? undefined : EVM_EXPLORERS[run.chainId];
  if (!explorer || !run.evmTx || !/^0x[0-9a-fA-F]{64}$/.test(run.evmTx)) return null;
  return { href: `${explorer.url}/tx/${run.evmTx}`, label: explorer.name };
}

export function nearLink(run: EvidenceRun): { href: string; label: string } | null {
  if (!run.nearTx || !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(run.nearTx)) return null;
  const host = run.network === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";
  return { href: `${host}/txns/${run.nearTx}`, label: "NearBlocks" };
}

/** Nearest rank: the value at position ceil(p * n). With few samples p95 is simply the slowest. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(p * sorted.length) - 1] ?? null;
}

/** The middle value, or the mean of the two middle values, as the README prints a median. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const half = sorted.length / 2;
  return sorted.length % 2 === 1 ? (sorted[Math.floor(half)] as number) : ((sorted[half - 1] as number) + (sorted[half] as number)) / 2;
}

interface Hop {
  id: string;
  label: string;
  /** Where the time goes. */
  where: string;
  from: keyof Timestamps;
  to: keyof Timestamps;
}

/** The legs of a run, in order, as the keeper timestamps them. */
export const HOPS: Hop[] = [
  { id: "near", label: "Rescue call included", where: "NEAR", from: "detected", to: "nearIncluded" },
  { id: "mpc", label: "Signature back from MPC", where: "NEAR", from: "nearIncluded", to: "signed" },
  { id: "send", label: "Signature checked, sent", where: "Keeper", from: "signed", to: "broadcast" },
  { id: "evm", label: "Included", where: "EVM chain", from: "broadcast", to: "included" },
];

export interface LatencyRow {
  id: string;
  label: string;
  where: string;
  samples: number;
  p50Ms: number | null;
  p95Ms: number | null;
  slowestMs: number | null;
}

function latencyRow(id: string, label: string, where: string, values: number[]): LatencyRow {
  return { id, label, where, samples: values.length, p50Ms: median(values), p95Ms: percentile(values, 0.95), slowestMs: percentile(values, 1) };
}

/** The median, p95 and the slowest per hop, and overall, computed from every run that recorded both ends. */
export function latencyTable(runs: EvidenceRun[]): { hops: LatencyRow[]; overall: LatencyRow } {
  const hops = HOPS.map(({ id, label, where, from, to }) => {
    const values = runs.flatMap(({ timestamps }) => {
      const start = timestamps[from];
      const end = timestamps[to];
      return start !== null && end !== null && end >= start ? [end - start] : [];
    });
    return latencyRow(id, label, where, values);
  });
  const overall = runs.flatMap((run) => (run.latencyMs === null ? [] : [run.latencyMs]));
  return { hops, overall: latencyRow("overall", "Detection to inclusion", "All of it", overall) };
}

export interface Tally {
  total: number;
  success: number;
  failed: number;
  aborted: number;
  unreadable: number;
  chains: string[];
  positions: number;
  /** True when no run touched a mainnet. */
  testnetOnly: boolean;
}

export function tally(runs: EvidenceRun[]): Tally {
  const count = (outcome: Outcome) => runs.filter((run) => run.outcome === outcome).length;
  const chainIds = new Set(runs.flatMap((run) => (run.chainId === null ? [] : [run.chainId])));
  // An Aave position is a borrower on a chain, whichever Levee contract registered it.
  const positions = new Set(runs.flatMap((run) => (run.borrower !== null ? [`${run.chainId}:${run.borrower.toLowerCase()}`] : run.positionId !== null ? [`${run.chainId}:#${run.positionId}`] : [])));
  return {
    total: runs.length,
    success: count("success"),
    failed: count("failed"),
    aborted: count("aborted"),
    unreadable: count("unreadable"),
    chains: [...chainIds].map((id) => CHAIN_NAMES[id] ?? `Chain ${id}`),
    positions: positions.size,
    testnetOnly: runs.every((run) => run.network === "testnet"),
  };
}

export interface MpcSample {
  run: number;
  outcome: string;
  elapsedMs: number;
  nearTx: string | null;
}

export interface MpcLatency {
  network: string;
  mpc: string;
  measuredAt: string;
  note: string;
  runs: number;
  signed: number;
  failed: number;
  p50Ms: number | null;
  p95Ms: number | null;
  slowestMs: number | null;
  samples: MpcSample[];
}

/** The signature-only measurement. The figures come from the samples, not from the file's summary. */
export function parseMpcLatency(raw: string): MpcLatency | null {
  try {
    const record = JSON.parse(raw) as Record<string, unknown>;
    const samples = (record.samples as Array<Record<string, unknown>>).map((sample) => ({
      run: count(sample.run) ?? 0,
      outcome: text(sample.outcome) ?? "unknown",
      elapsedMs: count(sample.elapsed_ms) ?? 0,
      nearTx: text(sample.near_tx),
    }));
    const signed = samples.filter((sample) => sample.outcome === "signed");
    const times = signed.map((sample) => sample.elapsedMs);
    return {
      network: text(record.network) ?? "unknown",
      mpc: text(record.mpc) ?? "unknown",
      measuredAt: text(record.measured_at) ?? "",
      note: text(record.note) ?? "",
      runs: samples.length,
      signed: signed.length,
      failed: samples.length - signed.length,
      p50Ms: median(times),
      p95Ms: percentile(times, 0.95),
      slowestMs: percentile(times, 1),
      samples,
    };
  } catch {
    return null;
  }
}

export function evidenceRoot(): string {
  return dirname(evidenceDir());
}

function readOptional(path: string): string | null {
  return existsSync(/* turbopackIgnore: true */ path) ? readFileSync(/* turbopackIgnore: true */ path, "utf8") : null;
}

export function readMpcLatency(root: string = evidenceRoot()): MpcLatency | null {
  const raw = readOptional(`${root}/mpc-latency-testnet.json`);
  return raw === null ? null : parseMpcLatency(raw);
}

/** One entry of evidence/claims.json: a public claim and the run or test behind it. */
export interface Claim {
  id: string;
  claim: string;
  run: string | null;
  /** NEAR accounts that must have no access keys, as make verify reads them. */
  noAccessKeys: string[];
}

export function parseClaims(raw: string): Claim[] {
  try {
    const claims = record(JSON.parse(raw)).claims;
    if (!Array.isArray(claims)) return [];
    return claims.flatMap((entry: unknown) => {
      const fields = record(entry);
      const id = text(fields.id);
      const claim = text(fields.claim);
      if (!id || !claim) return [];
      const keys = Array.isArray(fields.no_access_keys) ? fields.no_access_keys.filter((account: unknown): account is string => typeof account === "string") : [];
      return [{ id, claim, run: text(fields.run), noAccessKeys: keys }];
    });
  } catch {
    return [];
  }
}

export function readClaims(root: string = evidenceRoot()): Claim[] {
  const raw = readOptional(`${root}/claims.json`);
  return raw === null ? [] : parseClaims(raw);
}

export interface Rehearsal {
  /** The file's own statement of what this was. It is shown word for word. */
  label: string;
  run: EvidenceRun;
}

/** A run on a local fork. It is kept apart from the runs, because no public explorer can show it. */
export function readRehearsal(root: string = evidenceRoot()): Rehearsal | null {
  const raw = readOptional(`${root}/rehearsal/base-sepolia-fork-rescue.json`);
  if (raw === null) return null;
  try {
    const { label } = JSON.parse(raw) as { label?: unknown };
    if (typeof label !== "string" || !/fork/i.test(label)) return null;
    return { label, run: parseRun("rehearsal", raw) };
  } catch {
    return null;
  }
}
