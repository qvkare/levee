/**
 * Reads evidence/runs/*.json at build time (spec section 6). A record that cannot be parsed is
 * listed as unreadable and not dropped, because failed runs stay visible.
 *
 * Only prerendered pages may call readRuns. A Worker has no evidence folder at runtime, and a page
 * rendered there would report no runs whatever had happened.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";

export type Outcome = "success" | "failed" | "aborted" | "unreadable";

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
  nearTx: string | null;
  evmTx: string | null;
  evmBlock: number | null;
}

const OUTCOMES: readonly string[] = ["success", "failed", "aborted"];

const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

function latency(timestamps: unknown): number | null {
  if (typeof timestamps !== "object" || timestamps === null) return null;
  const { detected, included } = timestamps as Record<string, unknown>;
  const start = count(detected);
  const end = count(included);
  return start && end && end >= start ? end - start : null;
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
    latencyMs: latency(record.timestamps_ms),
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
