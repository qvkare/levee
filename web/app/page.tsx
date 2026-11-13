import { AddressForm } from "@/components/address-form.tsx";
import { BacktestSection } from "@/components/backtest.tsx";
import { Boards, WorstCase } from "@/components/boards.tsx";
import { LeveeHero, type HeroRun } from "@/components/levee-hero.tsx";
import { ReadSection } from "@/components/read-section.tsx";
import { RescueMap } from "@/components/rescue-map.tsx";
import { StopStrip, Terminus, stopsIntro } from "@/components/stops.tsx";
import { Timetable } from "@/components/timetable.tsx";
import { readDate, seconds } from "@/lib/format.ts";
import { getHomeReading } from "@/lib/home-reading.ts";
import { PROOF } from "@/lib/proof.ts";

/**
 * Prerendered, so it loads from static assets. The replay and the timetable come from the run records
 * at build time. The example reading is real at a stated time, and the browser reads it again.
 */
export const dynamic = "force-static";

/** The figures the first screen states, from the run the home page replays. */
function heroRun(): HeroRun | null {
  const { replay } = PROOF;
  if (!replay || replay.trigger === null || replay.target === null) return null;
  const total = replay.marks.included;
  return {
    before: replay.healthBefore.toFixed(2),
    after: replay.healthAfter.toFixed(2),
    trigger: replay.trigger.toFixed(2),
    target: replay.target.toFixed(2),
    amount: replay.amount,
    sold: replay.sale?.sold ?? null,
    chain: replay.chain,
    when: readDate(replay.detectedAt),
    total: seconds(total),
    keyless: replay.chosen === "keyless",
  };
}

export default async function Home() {
  const reading = await getHomeReading();
  const { replay } = PROOF;
  const hero = heroRun();

  return (
    <main id="main">
      {hero && <LeveeHero run={hero} />}

      {replay && (
        <div id="rescue">
          <RescueMap replay={replay} />
        </div>
      )}

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
          <p>Each actor has one job. The helper on the lending chain and the contract on NEAR enforce the limits, so a stolen keeper key stays inside them.</p>
        </div>
        <Boards />
        <WorstCase />
      </section>

      <Timetable next={{ href: "/proof", title: "Every run and every hop", body: "Per-hop times, the contracts and their keys, and the full backtest" }} />

      <BacktestSection />

      <ReadSection
        reading={reading}
        trigger={PROOF.readingTrigger}
        form={<AddressForm title="Check any address" lede="How far each Aave and Hyperliquid position is from liquidation. No wallet, no login." example={{ address: reading.report.address, label: "a public Aave borrower" }} />}
      />
    </main>
  );
}
