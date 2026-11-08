import Link from "next/link";
import { AddressForm } from "@/components/address-form.tsx";
import { BacktestSection } from "@/components/backtest.tsx";
import { Badge } from "@/components/badge.tsx";
import { Boards, WorstCase } from "@/components/boards.tsx";
import { ReadSection } from "@/components/read-section.tsx";
import { RescueMap } from "@/components/rescue-map.tsx";
import { StopStrip, Terminus, stopsIntro } from "@/components/stops.tsx";
import { Timetable } from "@/components/timetable.tsx";
import { getHomeReading } from "@/lib/home-reading.ts";
import { PROOF } from "@/lib/proof.ts";

/**
 * Prerendered, so it loads from static assets. The replay and the timetable come from the run records
 * at build time. The example reading is real at a stated time, and the browser reads it again.
 */
export const dynamic = "force-static";

/** What ran live, in one line under the offer, from the run records. */
function heroProof(): string | null {
  const { counts, days } = PROOF.modes.collateral;
  if (counts.success === 0) return null;
  const chain = counts.chains.join(" and ");
  const refused = counts.aborted > 0 ? ` and ${counts.aborted} the keeper refused` : "";
  // Runs are newest first, so the first landed collateral run is the last rescue.
  const last = PROOF.runs.find((run) => run.mode === "collateral" && run.outcome === "success");
  const keyless = PROOF.keyless ? `, ${last?.id === PROOF.keyless.run ? "the last" : "one"} after both contract accounts lost their last key` : "";
  return `Live on ${chain}, ${days}: ${counts.success} rescues from collateral${refused}${keyless}. Nothing is on a mainnet.`;
}

export default async function Home() {
  const reading = await getHomeReading();
  const { replay } = PROOF;
  const proofLine = heroProof();

  return (
    <main id="main">
      <div className="hero">
        <div>
          <p className="lines">
            <Badge lane="P" size="s" />
            <Badge lane="K" size="s" />
            <Badge lane="N" size="s" />
            <Badge lane="M" size="s" />
            <span className="t">Aave v3, signed on NEAR</span>
          </p>
          <h1>Below your trigger, Levee repays your Aave debt from your own collateral</h1>
          <p className="lede">
            When your health factor falls below the trigger you set, <b>a NEAR contract with no keys signs one call</b> that sells just enough of your collateral to repay USDC debt back to your target. <b>The position stays in your wallet.</b> On Base, an ownerless helper checks the trigger and the price against Aave’s oracle before anything moves.
          </p>
          {proofLine && (
            <p className="hero-proof">
              {proofLine}{" "}
              <Link href="/proof" prefetch={false}>
                Every run
              </Link>
            </p>
          )}
        </div>
        <AddressForm title="Check any address" lede="How far each Aave and Hyperliquid position is from liquidation. No wallet, no login." example={{ address: reading.report.address, label: "a public Aave borrower" }} />
      </div>

      {replay && <RescueMap replay={replay} />}

      <section className="s" id="how" aria-labelledby="how-h">
        <div className="sh">
          <h2 className="big" id="how-h">
            Stop by stop
          </h2>
          <p>{stopsIntro()}</p>
        </div>
        <StopStrip />
        <Terminus />
      </section>

      <section className="s s-tint" id="rules" aria-labelledby="rules-h">
        <div className="sh">
          <h2 className="big" id="rules-h">
            Who can do what
          </h2>
          <p>Each actor has one job. The helper on Base and the contract on NEAR enforce the limits, so a stolen keeper key stays inside them.</p>
        </div>
        <Boards />
        <WorstCase />
      </section>

      <Timetable next={{ href: "/proof", title: "Every run and every hop", body: "Per-hop times, the contracts and their keys, and the full backtest" }} />

      <BacktestSection />

      <ReadSection reading={reading} trigger={PROOF.readingTrigger} />
    </main>
  );
}
