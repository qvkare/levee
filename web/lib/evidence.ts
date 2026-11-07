/**
 * Reads evidence/runs/*.json at build time (spec section 6). A record that cannot be parsed is
 * listed as unreadable and not dropped, because failed runs stay visible.
 *
 * Only prerendered pages may call readRuns. A Worker has no evidence folder at runtime, and a page
 * rendered there would report no runs whatever had happened.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname } from "node:path";

export type Outcome = "success" | "failed" | "aborted" | "unreadable";

/** Each moment of a run, in milliseconds. Null when the run never got there. */
export interface Timestamps {
  detected: number | null;
  nearIncluded: number | null;
  signed: number | null;
  broadcast: number | null;
  included: number | null;
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
  };
  let record: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return unreadable;
    record = parsed as Record<string, unknown>;
  } catch {
    return unreadable;
  }
  const outcome = text(record.outcome);
  if (!outcome || !OUTCOMES.includes(outcome)) return { ...unreadable, failureReason: "This record has no valid outcome." };
  const timestamps = timestampsOf(record.timestamps_ms);
  return {
    id: text(record.run_id) ?? id,
    outcome: outcome as Outcome,
    network: text(record.network),
    chainId: count(record.chain_id),
    positionId: count(record.position_id),
    borrower: text(record.borrower),
    rescuer: text(record.rescuer),
    amount: text(record.amount),
    failureReason: text(record.failure_reason),
    healthBefore: text(record.health_factor_before),
    healthAfter: text(record.health_factor_after),
    latencyMs: latency(timestamps),
    timestamps,
    nearTx: text(record.near_tx),
    evmTx: text(record.evm_tx),
    evmBlock: count(record.evm_block),
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
  { id: "evm", label: "Repay included", where: "EVM chain", from: "broadcast", to: "included" },
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
  return { id, label, where, samples: values.length, p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95), slowestMs: percentile(values, 1) };
}

/** p50, p95 and the slowest per hop, and overall, computed from every run that recorded both ends. */
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
  const positions = new Set(runs.flatMap((run) => (run.positionId === null ? [] : [`${run.chainId}:${run.positionId}`])));
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
      p50Ms: percentile(times, 0.5),
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
