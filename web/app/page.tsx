import Link from "next/link";
import type { Address } from "viem";
import { AddressForm } from "@/components/address-form.tsx";
import { SectionChart } from "@/components/section-chart.tsx";
import { StageTable } from "@/components/stage-table.tsx";
import { shortAddress } from "@/lib/address.ts";
import { EXAMPLES } from "@/lib/examples.ts";
import { DEFAULT_TARGET } from "@/lib/math.ts";
import { chartModel } from "@/lib/reading.ts";
import { getRiskReport } from "@/lib/risk.ts";

/** The example level is rebuilt once a minute, so the first screen is fast and still live. */
export const revalidate = 60;

/** These are other people's positions and can close, so the first one still holding water is shown. */
async function liveExample() {
  let report = await getRiskReport(EXAMPLES[0].address as Address);
  for (const example of EXAMPLES.slice(1)) {
    if (chartModel(report).state !== "dry") break;
    report = await getRiskReport(example.address as Address);
  }
  return report;
}

export default async function Home() {
  const report = await liveExample();
  return (
    <>
      <section className="tool wrap">
        <h1>Levee repays your Aave debt from a reserve when your health factor crosses a trigger you set.</h1>
        <AddressForm />
      </section>

      <div className="wrap section-title">
        <h2>
          Live level of a public address,{" "}
          <Link href={`/a/${report.address}`} prefetch={false} className="mono">
            {shortAddress(report.address)}
          </Link>
        </h2>
      </div>
      <SectionChart model={chartModel(report)} target={DEFAULT_TARGET} label="River section for an example address" />

      <div className="wrap">
        <p className="chart-caption">
          Water rises as health falls. At 1.00 it reaches the crest and liquidation can start. This is a read of one public address, not of a Levee user. Paste your own above.
        </p>

        <section className="page-section">
          <h2>Other public addresses</h2>
          <ul className="examples">
            {EXAMPLES.map((example) => (
              <li key={example.address}>
                <Link href={`/a/${example.address}`} prefetch={false}>
                  {example.label}
                </Link>
              </li>
            ))}
          </ul>
        </section>

        <section className="page-section">
          <h2>Flood-stage table</h2>
          <StageTable />
        </section>
      </div>
    </>
  );
}
