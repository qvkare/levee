import Link from "next/link";
import { BacktestBrief } from "@/components/backtest-brief.tsx";
import { HomeWall } from "@/components/home-wall.tsx";
import { LeveeNote } from "@/components/levee-note.tsx";
import { Simulator, type SimulatorTerms } from "@/components/simulator.tsx";
import { shortAddress } from "@/lib/address.ts";
import { EXAMPLES } from "@/lib/examples.ts";
import { integer } from "@/lib/format.ts";
import { getHomeReading } from "@/lib/home-reading.ts";
import { buildWall, firstAave } from "@/lib/wall.ts";

/**
 * Prerendered, so it loads from static assets and its HTML holds a real reading at a stated time.
 * The browser takes a fresh reading on load.
 */
export const dynamic = "force-static";

const FALLBACK_TERMS: SimulatorTerms = { liquidationThreshold: 0.8, liquidationBonus: 0.05, source: "" };

export default async function Home() {
  const reading = await getHomeReading();
  const wall = buildWall(reading.report);
  const aave = firstAave(wall);
  const bonus = aave?.position.reserves?.liquidationBonus;
  const terms: SimulatorTerms =
    aave && bonus != null
      ? { liquidationThreshold: aave.position.liquidationThreshold, liquidationBonus: bonus, source: `Threshold and bonus from ${aave.name} at block ${integer(aave.market.blockNumber ?? 0)}.` }
      : FALLBACK_TERMS;

  return (
    <HomeWall reading={reading}>
      <section className="more more-top" aria-label="What Levee does">
        <LeveeNote first={wall.entries[0]} />
        <BacktestBrief />
      </section>
      <Simulator terms={terms} />
      <section className="sec" aria-labelledby="read">
        <h2 id="read">Read a public address.</h2>
        <p className="prose">Levee has no relationship with these addresses. They show what the tool reads, and the order on each wall is percentage move, not likelihood.</p>
        <ul className="addresses">
          {EXAMPLES.map((example) => (
            <li key={example.address}>
              <Link href={`/a/${example.address}`} prefetch={false}>
                {example.label}
                <code>{shortAddress(example.address)}</code>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </HomeWall>
  );
}
