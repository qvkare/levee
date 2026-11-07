import type { Metadata } from "next";
import { StackTable, type Column } from "@/components/stack-table.tsx";
import { CHAIN_NAMES, evmLink, nearLink, readRuns, type EvidenceRun, type Outcome } from "@/lib/evidence.ts";
import { integer } from "@/lib/format.ts";

/** Built once, from the evidence folder. It must not render on a Worker, which has no such folder. */
export const dynamic = "force-static";

export const metadata: Metadata = { title: "Proof", description: "Every recorded Levee run, including failures, with explorer links." };

const OUTCOME_NAMES: Record<Outcome, string> = { success: "Success", failed: "Failed", aborted: "Aborted", unreadable: "Unreadable" };

function Link({ link }: { link: { href: string; label: string } | null }) {
  return link ? (
    <a href={link.href} rel="noreferrer">
      {link.label}
    </a>
  ) : (
    "Not recorded"
  );
}

/** USDC has 6 decimals. Amounts are recorded in base units, so this avoids float rounding. */
function usdc(baseUnits: string | null): string {
  if (!baseUnits || !/^\d+$/.test(baseUnits)) return "Not recorded";
  const padded = baseUnits.padStart(7, "0");
  return `${integer(padded.slice(0, -6))}.${padded.slice(-6, -4)} USDC`;
}

const COLUMNS: Column<EvidenceRun>[] = [
  { label: "Run", wide: true, cell: (run) => <code>{run.id}</code> },
  { label: "Outcome", cell: (run) => <span className="medium">{OUTCOME_NAMES[run.outcome]}</span> },
  { label: "Network", cell: (run) => `${run.chainId === null ? "Not recorded" : (CHAIN_NAMES[run.chainId] ?? `Chain ${run.chainId}`)}${run.network ? `, ${run.network}` : ""}` },
  { label: "Amount", cell: (run) => usdc(run.amount) },
  { label: "Health before and after", cell: (run) => (run.healthBefore ? `${run.healthBefore} to ${run.healthAfter ?? "not recorded"}` : "Not recorded") },
  { label: "Detection to inclusion", cell: (run) => (run.latencyMs === null ? "Not recorded" : `${(run.latencyMs / 1000).toFixed(1)} s`) },
  { label: "NEAR", cell: (run) => <Link link={nearLink(run)} /> },
  { label: "EVM", cell: (run) => <Link link={evmLink(run)} /> },
  { label: "Failure reason", wide: true, cell: (run) => run.failureReason ?? "None" },
];

export default function ProofPage() {
  const runs = readRuns();
  const counts = runs.reduce<Record<string, number>>((tally, run) => ({ ...tally, [run.outcome]: (tally[run.outcome] ?? 0) + 1 }), {});
  const summary = (Object.keys(OUTCOME_NAMES) as Outcome[])
    .filter((outcome) => counts[outcome])
    .map((outcome) => `${counts[outcome]} ${OUTCOME_NAMES[outcome].toLowerCase()}`)
    .join(", ");

  return (
    <div className="wrap">
      <section className="page-head">
        <h1>{runs.length ? "Every recorded run" : "No live runs yet."}</h1>
        <p>
          {runs.length
            ? `${runs.length} ${runs.length === 1 ? "run" : "runs"}: ${summary}. Failed runs stay on this list. Each one comes from a file in evidence/runs, read when this site was built.`
            : "Levee has not rescued a position on any network that this site can show. When it has, each run will appear here with its NEAR and EVM transactions, including the ones that failed."}
        </p>
      </section>
      {runs.length > 0 && (
        <section aria-label="Runs">
          <StackTable columns={COLUMNS} rows={runs} rowKey={(run) => run.id} />
        </section>
      )}
    </div>
  );
}
