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

export default async function Home() {
  const reading = await getHomeReading();
  const { replay } = PROOF;

  return (
    <main id="main">
      <div className="hero">
        <div>
          <p className="lines">
            <Badge lane="P" size="s" />
            <Badge lane="K" size="s" />
            <Badge lane="N" size="s" />
            <Badge lane="M" size="s" />
            <span className="t">Aave v3 on Base and Arbitrum, signed on NEAR</span>
          </p>
          <h1>When your health factor crosses the trigger, NEAR signs the repay</h1>
          <p className="lede">
            Levee watches your Aave loan. At your trigger, a <b>NEAR contract signs one repay</b> from your USDC reserve, inside caps you set. <b>The position stays in your wallet</b>, and the keeper can’t send funds anywhere else.
          </p>
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
          <p>Each line has one job. The contract enforces the limits, so a stolen keeper key stays inside them.</p>
        </div>
        <Boards />
        <WorstCase />
      </section>

      <Timetable next={{ href: "/proof", title: "Every run and every hop", body: "Per-hop times, each signing sample and the full backtest" }} />

      <BacktestSection />

      <ReadSection reading={reading} trigger={PROOF.trigger} />
    </main>
  );
}
