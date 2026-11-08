import type { Metadata } from "next";
import { headers } from "next/headers";
import { cache } from "react";
import type { Address } from "viem";
import { ReadState } from "@/components/read-state.tsx";
import { Reading } from "@/components/reading.tsx";
import { ADDRESS_ERRORS, parseAddress, shortAddress } from "@/lib/address.ts";
import { clientKey } from "@/lib/limit.ts";
import { DEFAULT_TARGET, parseTarget } from "@/lib/math.ts";
import { PROOF } from "@/lib/proof.ts";
import { READS_PER_MINUTE, allowRead } from "@/lib/rate-limit.ts";
import { verdict } from "@/lib/reading.ts";
import { withTarget } from "@/lib/report.ts";
import { getRiskReport } from "@/lib/risk.ts";
import { applyFall, parseFall } from "@/lib/what-if.ts";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ address: string }>;
  searchParams: Promise<{ target?: string | string[]; fall?: string | string[] }>;
}

/** The page and its metadata run together, and should share one read and one count against the limit. */
const reportFor = cache(async (address: Address) => {
  const allowed = await allowRead(clientKey(await headers()));
  return allowed ? getRiskReport(address) : null;
});

async function addressFrom(params: Props["params"]) {
  const { address } = await params;
  let input = address;
  try {
    input = decodeURIComponent(address);
  } catch {
    // A malformed escape is just another bad address. The parser below refuses it.
  }
  return { input, parsed: parseAddress(input) };
}

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { parsed } = await addressFrom(params);
  if (!parsed.ok) return { title: "Not an address", robots: { index: false } };
  const report = await reportFor(parsed.address);
  return { title: shortAddress(parsed.address), description: report ? verdict(report).text : undefined, robots: { index: false } };
}

export default async function Page({ params, searchParams }: Props) {
  const { input, parsed } = await addressFrom(params);
  if (!parsed.ok) {
    return <ReadState title="That isn’t an address Levee can read" body="Paste an EVM address: 0x and 40 hex characters. Levee reads it on Aave on Base and Arbitrum, and on Hyperliquid." value={input} error={ADDRESS_ERRORS[parsed.error]} />;
  }

  const read = await reportFor(parsed.address);
  if (!read) {
    return (
      <ReadState title="Too many reads from this connection" body={`Each connection can read ${READS_PER_MINUTE} addresses a minute. Wait a minute and read again.`} value={parsed.address} retry={`/a/${parsed.address}`} />
    );
  }

  const query = await searchParams;
  const report = withTarget(read, parseTarget(first(query.target)) ?? DEFAULT_TARGET);
  const fall = parseFall(first(query.fall));
  const simulated = fall === null ? null : applyFall(report, fall);
  // The key resets the page's state when the address or the simulated fall changes.
  return (
    <Reading
      key={`${report.address}:${fall}`}
      report={simulated?.report ?? report}
      whatIf={simulated?.whatIf ?? null}
      trigger={PROOF.readingTrigger}
      measured={{ p50Ms: PROOF.modes.collateral.timing.overall.p50Ms, samples: PROOF.modes.collateral.timing.overall.samples }}
    />
  );
}
