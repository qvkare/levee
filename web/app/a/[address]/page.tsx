import type { Metadata } from "next";
import { headers } from "next/headers";
import { cache } from "react";
import type { Address } from "viem";
import { LiveReport } from "@/components/live-report.tsx";
import { SiteHeader } from "@/components/site-header.tsx";
import { Axis } from "@/components/wall.tsx";
import { ADDRESS_ERRORS, parseAddress, shortAddress } from "@/lib/address.ts";
import { clientKey } from "@/lib/limit.ts";
import { DEFAULT_TARGET, parseTarget } from "@/lib/math.ts";
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

function Plain({ title, body, value, error }: { title: string; body?: string; value?: string; error?: string }) {
  return (
    <>
      <SiteHeader value={value} error={error} />
      <main id="main">
        <div className="board">
          <div className="empty">
            <h1 className="lead-title">{title}</h1>
            {body && <p>{body}</p>}
          </div>
          <Axis />
        </div>
      </main>
    </>
  );
}

export default async function Page({ params, searchParams }: Props) {
  const { input, parsed } = await addressFrom(params);
  if (!parsed.ok) return <Plain title="That address cannot be read." value={input} error={ADDRESS_ERRORS[parsed.error]} />;

  const read = await reportFor(parsed.address);
  if (!read) return <Plain title="Too many reads from this connection." body={`Reads are limited to ${READS_PER_MINUTE} a minute. Try again shortly.`} value={parsed.address} />;

  const query = await searchParams;
  const report = withTarget(read, parseTarget(first(query.target)) ?? DEFAULT_TARGET);
  const fall = parseFall(first(query.fall));
  const simulated = fall === null ? null : applyFall(report, fall);
  // The key resets the page's state when the address or the simulated fall changes.
  return <LiveReport key={`${report.address}:${fall}`} report={simulated?.report ?? report} whatIf={simulated?.whatIf ?? null} />;
}
