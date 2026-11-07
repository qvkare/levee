import type { Metadata } from "next";
import { AddressForm } from "@/components/address-form.tsx";
import { Report } from "@/components/report.tsx";
import { ADDRESS_ERRORS, parseAddress, shortAddress } from "@/lib/address.ts";
import { DEFAULT_TARGET, parseTarget } from "@/lib/math.ts";
import { verdict } from "@/lib/reading.ts";
import { getRiskReport } from "@/lib/risk.ts";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ address: string }>;
  searchParams: Promise<{ target?: string | string[] }>;
}

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

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { parsed } = await addressFrom(params);
  if (!parsed.ok) return { title: "Not an address", robots: { index: false } };
  const report = await getRiskReport(parsed.address);
  return { title: `Stage report for ${shortAddress(parsed.address)}`, description: verdict(report).text, robots: { index: false } };
}

export default async function Page({ params, searchParams }: Props) {
  const { input, parsed } = await addressFrom(params);
  if (!parsed.ok) {
    return (
      <section className="tool wrap">
        <h1>That address cannot be read.</h1>
        <AddressForm value={input} error={ADDRESS_ERRORS[parsed.error]} />
      </section>
    );
  }

  const { target } = await searchParams;
  const chosen = parseTarget(Array.isArray(target) ? target[0] : target) ?? DEFAULT_TARGET;
  const report = await getRiskReport(parsed.address, chosen);
  return (
    <>
      <section className="tool wrap">
        <h1>Stage report for <span className="mono">{shortAddress(report.address)}</span></h1>
        <p className="mono full-address">{report.address}</p>
        <AddressForm key={report.address} />
      </section>
      <Report key={report.address} report={report} />
    </>
  );
}
