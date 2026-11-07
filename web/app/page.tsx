import Link from "next/link";
import { AddressForm } from "@/components/address-form.tsx";
import { FloodDrill } from "@/components/flood-drill.tsx";
import { PositionSimulator } from "@/components/position-simulator.tsx";
import { StackTable, type Column } from "@/components/stack-table.tsx";
import { StateTag } from "@/components/state-tag.tsx";
import { getDrillTerms } from "@/lib/drill-terms.ts";
import { readRuns } from "@/lib/evidence.ts";
import { EXAMPLES } from "@/lib/examples.ts";

/**
 * Prerendered, so it loads from static assets and its HTML holds a real reading at a stated block.
 * The drill takes a fresh reading in the browser. Evidence is only readable here, at build time, so
 * this page must not render on a Worker.
 */
export const dynamic = "force-static";

interface Step {
  id: number;
  title: string;
  body: string;
  who: string;
  where: string;
}

const STEPS: Step[] = [
  {
    id: 1,
    title: "The keeper reads the stage",
    body: "Every 5 seconds it reads your health factor from at least two RPC endpoints. It acts only if they agree within 0.5% and are under 30 seconds old.",
    who: "Keeper",
    where: "Base or Arbitrum",
  },
  {
    id: 2,
    title: "The trigger is crossed",
    body: "Health factor is below your trigger. The keeper works out the repay that reaches your target, capped by the position, the rescuer's USDC balance and the debt.",
    who: "Keeper",
    where: "Off chain",
  },
  {
    id: 3,
    title: "The contract checks the caps",
    body: "The keeper calls rescue with a position id, an amount and fees. The contract checks the per-rescue cap, the daily cap, the cooldown and the fee ceilings, then builds the transaction itself.",
    who: "Levee contract",
    where: "NEAR",
  },
  {
    id: 4,
    title: "The MPC network signs",
    body: "The contract asks v1.signer to sign for the rescuer address derived for your position.",
    who: "MPC network",
    where: "NEAR",
  },
  {
    id: 5,
    title: "The repay lands",
    body: "The keeper checks the recovered address and broadcasts. Aave applies the USDC to your debt. Your collateral stays where it is.",
    who: "Keeper, Aave Pool",
    where: "Base or Arbitrum",
  },
  {
    id: 6,
    title: "The run is recorded",
    body: "The keeper reads health factor again and writes a record to evidence, whether the run worked or not.",
    who: "Keeper",
    where: "Evidence",
  },
];

const STEP_COLUMNS: Column<Step>[] = [
  { label: "Step", cell: (step) => step.id },
  { label: "Who acts", cell: (step) => step.who },
  { label: "Where", cell: (step) => step.where },
  {
    label: "What happens",
    wide: true,
    cell: (step) => (
      <>
        <span className="medium">{step.title}.</span> {step.body}
      </>
    ),
  },
];

interface Attempt {
  attempt: string;
  rule: string;
}

const ATTEMPTS: Attempt[] = [
  {
    attempt: "Withdraw your collateral",
    rule: "The contract signs only approve, repay and transfer, each to a fixed target. No call it can sign withdraws from Aave, and your collateral stays in your wallet's position.",
  },
  {
    attempt: "Change the recipient",
    rule: "rescue takes a position id, an amount and fees, and nothing else. The contract writes the call itself: Pool.repay(USDC, amount, 2, borrower), with the borrower fixed at registration.",
  },
  {
    attempt: "Drain the reserve",
    rule: "rescue can only repay your debt, within the per-rescue cap, the daily cap and the cooldown. Only the owner can call withdraw_float, and it pays only the registered borrower.",
  },
];

const ATTEMPT_COLUMNS: Column<Attempt>[] = [
  { label: "A stolen keeper key tries to", cell: (row) => <span className="medium">{row.attempt}</span> },
  { label: "Result", cell: () => <span className="refused">Refused</span> },
  { label: "The contract's rule", wide: true, cell: (row) => row.rule },
];

export default async function Home() {
  const [terms, runs] = await Promise.all([getDrillTerms("built"), readRuns()]);
  const failed = runs.filter((run) => run.outcome !== "success").length;

  return (
    <>
      <section className="hero wrap" aria-labelledby="claim">
        <div>
          <h1 id="claim" className="claim">
            Repay your Aave debt before a liquidator does.
          </h1>
          <p className="lede">
            Levee holds a USDC reserve at a rescuer address that a NEAR contract signs for. When your health factor crosses a trigger you set, a keeper asks the contract to repay your debt, within caps you
            set. Your position stays in your wallet, and the keeper cannot send funds anywhere else.
          </p>
          <AddressForm />
          <div className="examples">
            <p>Or read a public address:</p>
            <ul>
              {EXAMPLES.map((example) => (
                <li key={example.address}>
                  <Link href={`/a/${example.address}`} prefetch={false}>
                    {example.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <FloodDrill initial={terms} />
      </section>

      <section id="try" className="band wrap" aria-labelledby="try-title">
        <div className="band-head">
          <h2 id="try-title">
            Try a position <StateTag state="Simulation" />
          </h2>
          <p>Set a position, a reserve and a fall. The numbers come from the same functions as the API.</p>
        </div>
        <PositionSimulator terms={terms} />
      </section>

      <section id="how" className="band wrap" aria-labelledby="how-title">
        <div className="band-head">
          <h2 id="how-title">How a rescue runs</h2>
          <p>
            Six steps, in order. The <Link href="/how">trust table and failure conditions</Link> have a page of their own.
          </p>
        </div>
        <StackTable columns={STEP_COLUMNS} rows={STEPS} rowKey={(step) => String(step.id)} />
      </section>

      <section id="keys" className="band wrap" aria-labelledby="keys-title">
        <div className="band-head">
          <h2 id="keys-title">
            What each key can do <StateTag state="Simulation" />
          </h2>
          <p>
            The keeper key is the one most likely to be stolen, because it stays online. Here it tries the three things a thief would want. These are the contract&apos;s rules as specified. They will link to tests
            and transactions when those exist.
          </p>
        </div>
        <StackTable columns={ATTEMPT_COLUMNS} rows={ATTEMPTS} rowKey={(row) => row.attempt} />
        <p className="note">
          The worst a stolen keeper key can do is repay your debt early, burn rescuer gas up to the fee ceiling, or burn the daily budget.
        </p>
      </section>

      <section id="limits" className="band wrap" aria-labelledby="limits-title">
        <div className="band-head">
          <h2 id="limits-title">Limits</h2>
          <p>
            A rescue is a race, and it can be lost. The <Link href="/how#fails">failure conditions</Link> are published.
          </p>
        </div>
        <ul className="limits">
          <li>Unaudited. Do not use it with funds you cannot lose.</li>
          <li>Hop timings are not yet measured. They will appear when real runs exist.</li>
          <li>A liquidator can win the race, the reserve can run out, and the MPC network can be down.</li>
          <li>The contract cannot read the lending chain, so the trigger lives in an off-chain keeper. If the keeper stops, nothing fires.</li>
          <li>The MPC network is trusted for custody of the rescuer key.</li>
          <li>USDC debt only, on Aave v3 on Base and Arbitrum.</li>
          <li>The off-venue reserve needs partner access. Hyperliquid top-ups are a separate gate and are not live.</li>
        </ul>
      </section>

      <section id="proof" className="band wrap" aria-labelledby="proof-title">
        <div className="band-head">
          <h2 id="proof-title">Proof</h2>
          <p>
            {runs.length === 0
              ? "No live runs yet. When Levee has rescued a position, each run will be listed with its transactions, including the ones that failed."
              : `${runs.length} recorded ${runs.length === 1 ? "run" : "runs"}, ${failed} of them failed or aborted. Failed runs stay on the list.`}{" "}
            <Link href="/proof">Open the run list</Link>.
          </p>
        </div>
      </section>
    </>
  );
}
