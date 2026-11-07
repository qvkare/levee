import type { Metadata } from "next";
import Link from "next/link";
import { MeasuredTable } from "@/components/measured-table.tsx";
import { RouteQuotePanel } from "@/components/route-quote.tsx";
import { SiteHeader } from "@/components/site-header.tsx";
import { TextTable, type Column } from "@/components/text-table.tsx";
import { latencyTable, readRuns, tally } from "@/lib/evidence.ts";
import { joined } from "@/lib/format.ts";
import { SCHEMA } from "@/lib/types.ts";

/** Built once. The measured table comes from the evidence folder, which a Worker does not have. */
export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "How a rescue runs",
  description: "How a Levee rescue runs, who can do what, the conditions under which it fails, and what has been measured.",
};

interface Step {
  title: string;
  body: string;
  who: string;
  where: string;
  /** A live dry quote for the reserve's route sits under this step. */
  quote?: boolean;
}

const STEPS: Step[] = [
  { title: "The keeper reads health factor", body: "Every 5 seconds, from at least two RPC endpoints. It acts only if they agree within 0.5% and are under 30 seconds old.", who: "Keeper", where: "Base or Arbitrum" },
  { title: "The trigger is crossed", body: "Health factor is below your trigger. The keeper works out the repay that reaches your target, capped by the position, the rescuer's USDC balance and allowance, and the USDC debt.", who: "Keeper", where: "Off chain" },
  { title: "The keeper calls rescue", body: "It reads the rescuer's nonce and fees, and calls rescue on the NEAR contract with a key that can do nothing else. It sends a position id, an amount and fees. No calldata, target or payload.", who: "Keeper", where: "NEAR" },
  { title: "The contract checks the caps", body: "Per-rescue cap, daily cap, cooldown and fee ceilings. Then it builds the transaction itself: Pool.repay(USDC, amount, 2, borrower).", who: "Levee contract", where: "NEAR" },
  { title: "The MPC network signs", body: "The contract asks v1.signer to sign for the rescuer address derived for your position.", who: "MPC network", where: "NEAR" },
  { title: "The repay lands", body: "The keeper checks the recovered address and broadcasts. Aave applies the USDC to your debt. Your collateral stays where it is.", who: "Keeper, Aave Pool", where: "Base or Arbitrum" },
  { title: "The run is recorded", body: "The keeper reads health factor again and writes a record to evidence, whether the run worked or not.", who: "Keeper", where: "Evidence" },
  {
    title: "The reserve refills the rescuer",
    body: "Not built yet. In the Reserve phase, USDC held off the lending chain goes back to the rescuer address through NEAR Intents, to pinned destinations only. It needs partner access. Until then the rescuer holds the USDC it repays with.",
    who: "Reserve, NEAR Intents",
    where: "To Base or Arbitrum",
    quote: true,
  },
];

interface Actor {
  actor: string;
  role: string;
  can: string;
  cannot: string;
}

const ACTORS: Actor[] = [
  { actor: "Owner", role: "NEAR account", can: "Register, set caps, pause, and withdraw float to the registered borrower.", cannot: "Be bypassed by the keeper." },
  { actor: "Keeper", role: "NEAR function-call key limited to rescue", can: "Ask the contract to sign a repay within caps. Fire early.", cannot: "Change the destination, the asset or the borrower. Exceed caps. Withdraw." },
  { actor: "Levee contract", role: "NEAR contract", can: "Sign approve, repay and transfer to fixed targets.", cannot: "Sign arbitrary payloads. It has no admin and no full-access key on mainnet." },
  { actor: "MPC network", role: "v1.signer", can: "Sign for the derived address. It is trusted for custody of the rescuer key.", cannot: "Levee places no limit on it. This trust is not removed." },
  { actor: "Aave Pool", role: "Aave v3 on Base or Arbitrum", can: "Pull USDC the rescuer approved.", cannot: "Pull more than the allowance, which is at most 30 days of the daily cap." },
];

const ACTOR_COLUMNS: Column<Actor>[] = [
  {
    label: "Who",
    cell: (row) => (
      <>
        {row.actor}
        <small>{row.role}</small>
      </>
    ),
  },
  { label: "Can", plain: true, cell: (row) => row.can },
  { label: "Cannot", plain: true, cell: (row) => row.cannot },
];

interface Attempt {
  attempt: string;
  rule: string;
}

const ATTEMPTS: Attempt[] = [
  { attempt: "Withdraw your collateral", rule: "The contract signs only approve, repay and transfer, each to a fixed target. No call it can sign withdraws from Aave, and your collateral stays in your wallet's position." },
  { attempt: "Change the recipient", rule: "rescue takes a position id, an amount and fees, and nothing else. The contract writes the call itself: Pool.repay(USDC, amount, 2, borrower), with the borrower fixed at registration." },
  { attempt: "Drain the reserve", rule: "rescue can only repay your debt, within the per-rescue cap, the daily cap and the cooldown. Only the owner can call withdraw_float, and it pays only the registered borrower." },
];

const ATTEMPT_COLUMNS: Column<Attempt>[] = [
  { label: "A stolen keeper key tries to", cell: (row) => row.attempt },
  { label: "Result", cell: () => "Refused" },
  { label: "The contract's rule", plain: true, cell: (row) => row.rule },
];

interface FailureCondition {
  condition: string;
  result: string;
  shows: string;
}

const FAILURES: FailureCondition[] = [
  { condition: "Reserve empty", result: "There is no USDC to repay with, so no rescue lands.", shows: "The position keeps falling. The run is recorded as failed." },
  { condition: "Route slow", result: "A reserve held off the lending chain has to arrive first. If it arrives after the price has moved, it arrives too late.", shows: "This applies to the Reserve phase, which needs partner access." },
  { condition: "MPC down", result: "The contract cannot get a signature, so nothing is sent. The budget is released.", shows: "A rescue_failed event on NEAR." },
  { condition: "A liquidator wins the race", result: "The price can reach liquidation before a rescue is included. Liquidators act first and the collateral is sold.", shows: "The run is recorded as failed, with its timings." },
  { condition: "Keeper down", result: "The trigger lives in the keeper, off chain. The contract cannot read the lending chain, so nothing fires without a keeper.", shows: "No run at all. Silence is a failure too." },
  { condition: "RPC endpoints disagree", result: "The keeper acts only when two endpoints agree within 0.5% and are under 30 seconds old.", shows: "The keeper holds until they agree, which spends time. One run on /proof stopped this way." },
  { condition: "A cap is reached", result: "Per-rescue cap, daily cap and cooldown are checked by the contract. A rescue past any of them is refused.", shows: "The contract rejects the call, and a position may stay below its target." },
  { condition: "Wrong nonce", result: "The contract cannot see the EVM nonce. A wrong nonce wastes budget, but cannot move value anywhere else.", shows: "The signed transaction does not land." },
  { condition: "The price keeps falling", result: "A repay lowers debt, but the position stays open. A large enough fall still reaches liquidation.", shows: "A later rescue, or a liquidation once caps run out." },
];

const FAILURE_COLUMNS: Column<FailureCondition>[] = [
  { label: "Condition", cell: (row) => row.condition },
  { label: "What happens", plain: true, cell: (row) => row.result },
  { label: "What you see", plain: true, cell: (row) => row.shows },
];

const PHASES = [
  { phase: "Core", scope: "Aave v3 on Base and Arbitrum, USDC debt, NEAR contract, Chain Signatures rescuer address, deterministic keeper, this public tool, evidence." },
  { phase: "Reserve", scope: "An off-venue reserve in a NEAR Intents Agent API wallet with pinned destinations. Needs partner access." },
  { phase: "Hyperliquid", scope: "Cross-margin top-ups up to a loss limit you set. A separate gate, not part of the core, and not live." },
];

const LIMITS = [
  "Unaudited. Do not use it with funds you cannot lose.",
  "A liquidator can win the race, the reserve can run out, and the MPC network can be down.",
  "The contract cannot read the lending chain, so the trigger lives in an off-chain keeper. If the keeper stops, nothing fires.",
  "The MPC network is trusted for custody of the rescuer key.",
  "USDC debt only, on Aave v3 on Base and Arbitrum. A position with debt in anything else cannot be repaid.",
  "The off-venue reserve needs partner access. Hyperliquid top-ups are a separate gate and are not live. Isolated Hyperliquid positions would not be covered, because a credit to the account does not reach isolated margin.",
  "Nothing described here is a promise that a position will survive.",
];

const API_EXAMPLE = `{
  "schema": "${SCHEMA}",
  "address": "0x...",            // EIP-55
  "generatedAt": "...",          // ISO 8601, UTC
  "status": "ok",                // ok, partial or unavailable
  "target": 1.5,                 // health factor used for repay
  "failures": [],                // what is missing, and why
  "nearest": { "venue": "aave.base", "standing": "open", "fall": 0.12 },
  "aave": {
    "base": {
      "status": "ok",
      "blockNumber": "...",      // every figure was read at this block
      "position": {
        "standing": "open",      // none, open, close or liquidatable
        "healthFactor": 1.138,   // null with no debt
        "collateralUsd": 0,
        "debtUsd": 0,
        "liquidationThreshold": 0.84,
        "dropToLiquidation": {
          "fraction": 0.12,
          "formula": "1 - 1/HF",
          "assumption": "...",
          "assumptionHolds": true,
          "note": null
        },
        "repay": { "target": 1.5, "usd": 0, "usdcDebtUsd": 0, "usdcCovers": true },
        "reserves": { "collateral": [], "debt": [], "liquidationBonus": 0.05 },
        "raw": { "healthFactor": "..." }   // exact contract outputs
      }
    },
    "arbitrum": {}
  },
  "hyperliquid": {
    "status": "ok",
    "mode": "unified",           // standard, unified, portfolio, dex-abstraction or unknown
    "marginRatio": 3.01,         // equity / maintenance, null if not computed
    "pools": [],
    "positions": [
      { "market": "BTC", "margin": "cross", "liquidationPrice": 0, "distance": 0.91, "covered": true }
    ]
  }
}`;

export default function HowPage() {
  const runs = readRuns();
  const counts = tally(runs);
  const { hops, overall } = latencyTable(runs);

  return (
    <>
      <SiteHeader here="how" />
      <main id="main">
        <div className="lead-block">
          <h1 className="lead-title">A keeper watches health factor. A contract signs the repay, within caps you set.</h1>
          <p>
            Levee repays a borrower&apos;s debt from a reserve when their health factor crosses a trigger they set. The position stays in the borrower&apos;s wallet. The keeper cannot send funds anywhere else. <b>Unaudited, and a working draft.</b>
          </p>
        </div>

        <ol className="steps" role="list" aria-label="How a rescue runs, in order">
          {STEPS.map((step, index) => (
            <li key={step.title} className="step">
              <p className="step-who">
                <b>{step.who}</b> {step.where}
              </p>
              <div className="step-body">
                <span className="step-n">{index + 1}</span>
                <div>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                  {step.quote && <RouteQuotePanel from="arbitrum" to="base" amount={20} />}
                </div>
              </div>
            </li>
          ))}
        </ol>

        <section className="sec" aria-labelledby="repay">
          <h2 id="repay">The repay is one line of arithmetic.</h2>
          <p className="prose">To reach target T, with collateral C in USD, liquidation threshold L and debt D:</p>
          <p className="formula">
            <code>R = D - (C * L) / T</code>
          </p>
          <p className="prose">The trigger, target and RPC list live off chain. No LLM is involved.</p>
        </section>

        <section className="sec" aria-labelledby="trust">
          <h2 id="trust">Who can do what.</h2>
          <TextTable columns={ACTOR_COLUMNS} rows={ACTORS} rowKey={(row) => row.actor} label="Trust model" />
          <p className="prose">The worst a stolen keeper key can do is repay the borrower&apos;s debt early, burn rescuer gas up to the fee ceiling, or burn the daily budget.</p>
          <p className="prose">The contract cannot read the lending chain, so it does not know the health factor. The trigger is kept by the keeper, off chain. Caps bound what any trigger can do.</p>
          <h3>What a stolen keeper key cannot do</h3>
          <TextTable columns={ATTEMPT_COLUMNS} rows={ATTEMPTS} rowKey={(row) => row.attempt} label="What a stolen keeper key tries" />
          <p className="note">These are the contract&apos;s rules as specified.</p>
        </section>

        <section id="fails" className="sec" aria-labelledby="fails-title">
          <h2 id="fails-title">When it fails.</h2>
          <p className="prose">A rescue is a race, and it can be lost. These are the conditions we know of.</p>
          <TextTable columns={FAILURE_COLUMNS} rows={FAILURES} rowKey={(row) => row.condition} label="Failure conditions" />
        </section>

        <section id="measured" className="sec" aria-labelledby="measured-title">
          <h2 id="measured-title">What has been measured.</h2>
          <p className="prose">
            {overall.samples} full runs on {joined(counts.chains)}, a testnet, from {counts.positions === 1 ? "one position" : `${counts.positions} positions`}. That is too few for a p95 to mean much: with this many runs it is the slowest run. Nothing here has been measured on a mainnet, or during a crash.
          </p>
          <MeasuredTable hops={hops} overall={overall} />
          <p className="note">
            Every run, with its transactions, is on <Link href="/proof">the proof page</Link>.
          </p>
        </section>

        <section id="limits" className="sec" aria-labelledby="limits-title">
          <h2 id="limits-title">Limits.</h2>
          <ul className="prose-list">
            {LIMITS.map((limit) => (
              <li key={limit}>{limit}</li>
            ))}
          </ul>
        </section>

        <section className="sec" aria-labelledby="reading">
          <h2 id="reading">How to read the wall.</h2>
          <p className="prose">The wall is liquidation. Each position stands at the percentage move that would take it there, and the nearer it stands the larger it is set. The order is percentage move in price, not likelihood: a 12% fall in WETH and a 43% rise in AERO share one axis, and they are not equally likely.</p>
          <p className="prose">
            On Aave the distance is <code>1 - 1/HF</code>. It holds for volatile collateral against stable debt: all collateral falls together and the debt keeps its value. The tool checks what each position holds, and says when that is not the case. A wstETH position against WETH debt, for one, does not care about a market fall, only about one asset falling against the other.
          </p>
          <p className="prose">Repay figures use Aave oracle prices and assume no further price move. Levee repays USDC debt only, so the tool shows how much of a repay USDC debt can cover. An outlined number is a position Levee cannot reach.</p>
          <p className="prose">
            On Hyperliquid, margin ratio is equity divided by maintenance margin, and liquidation is at 1.00. The account mode, from <code>userAbstraction</code>, decides where equity is read. Unified accounts keep it in the spot balance, so per-DEX state alone would understate it. Portfolio margin uses a different rule that needs borrow caps and oracle prices, so the tool shows those positions without a ratio.
          </p>
          <p className="prose">For scale: the worst 15-minute drops on 2025-10-10 were 11.74% for BTC, 13.02% for ETH and 28.8% for SOL, on Binance perpetual futures.</p>
        </section>

        <section className="sec" aria-labelledby="phases">
          <h2 id="phases">What is in each phase.</h2>
          <TextTable columns={[{ label: "Phase", cell: (row) => row.phase }, { label: "Scope", plain: true, cell: (row) => row.scope }]} rows={PHASES} rowKey={(row) => row.phase} />
        </section>

        <section id="api" className="sec" aria-labelledby="api-title">
          <h2 id="api-title">The same data as JSON.</h2>
          <p className="prose">
            <code>GET /api/risk?address=0x...&amp;target=1.5</code> returns what the report page shows. There is no key. The target is optional, from 1.05 to 3. Results are cached for up to 15 seconds, or 5 when some figures are missing, and one connection can make 30 reads a minute.
          </p>
          <p className="prose">
            A bad address or target returns 400 with <code>error.code</code>. Past the limit it returns 429. If no source answers, the same shape comes back with status 503. A null means the figure is missing, not zero. The shape below is shortened, and <code>schema</code> changes only when a field is removed or changes meaning.
          </p>
          <pre>
            <code>{API_EXAMPLE}</code>
          </pre>
        </section>
      </main>
    </>
  );
}
