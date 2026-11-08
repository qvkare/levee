import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/badge.tsx";
import { Boards, WorstCase } from "@/components/boards.tsx";
import { MeasuredTable } from "@/components/measured-table.tsx";
import { RouteQuotePanel } from "@/components/route-quote.tsx";
import { StopLine, Terminus } from "@/components/stops.tsx";
import { TextTable, type Column } from "@/components/text-table.tsx";
import { TimeBar } from "@/components/time-bar.tsx";
import { joined } from "@/lib/format.ts";
import { PROOF } from "@/lib/proof.ts";
import { SCHEMA } from "@/lib/types.ts";

/** Built once. The measured hops come from the run records, inlined at build time. */
export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "How a rescue runs",
  description: "How a Levee rescue runs, stop by stop, who can do what, when it fails, what has been measured and what is not built yet.",
};

interface Attempt {
  attempt: string;
  rule: string;
}

const ATTEMPTS: Attempt[] = [
  { attempt: "Withdraw your collateral", rule: "The contract signs only approve, repay and transfer, each to a fixed target. No call it can sign withdraws from Aave, and your collateral stays in your wallet’s position." },
  { attempt: "Change the recipient", rule: "rescue takes a position id, an amount and fees, and nothing else. The contract writes the call itself, Pool.repay(USDC, amount, 2, borrower), with the borrower fixed at registration." },
  { attempt: "Drain the reserve", rule: "rescue can only repay your debt, within the per-rescue cap, the daily cap and the cooldown. Only the owner can call withdraw_float, and it pays only the registered borrower." },
  { attempt: "Pull more through the Pool", rule: "The Aave Pool can pull only what the rescuer approved, and the owner sets that allowance: at most 30 days of the daily cap." },
];

const ATTEMPT_COLUMNS: Column<Attempt>[] = [
  { label: "A stolen keeper key tries to", cell: (row) => row.attempt },
  { label: "Result", cell: () => "Refused" },
  { label: "The rule that refuses it", plain: true, cell: (row) => row.rule },
];

interface FailureCondition {
  condition: string;
  result: string;
  shows: string;
}

const FAILURES: FailureCondition[] = [
  { condition: "Reserve empty", result: "There is no USDC to repay with, so no rescue lands.", shows: "The position keeps falling. The run is recorded as failed." },
  { condition: "Route slow", result: "A reserve held off the lending chain has to arrive first. If it arrives after the price has moved, it is too late.", shows: "This applies to the Reserve phase, which needs partner access." },
  { condition: "MPC down", result: "The contract cannot get a signature, so nothing is sent. The budget is released.", shows: "A rescue_failed event on NEAR." },
  { condition: "A liquidator wins the race", result: "The price can reach liquidation before a rescue is included. Liquidators act first and the collateral is sold.", shows: "The run is recorded as failed, with its timings." },
  { condition: "Keeper down", result: "The trigger lives in the keeper, off chain. The contract cannot read the lending chain, so nothing fires without a keeper.", shows: "No run at all. Silence is a failure too." },
  { condition: "RPCs disagree", result: "The keeper acts only when two endpoints agree within 0.5% and are under 30 seconds old.", shows: "The keeper holds until they agree. One run on the proof page stopped this way." },
  { condition: "A cap is reached", result: "Per-rescue cap, daily cap and cooldown are checked by the contract. A rescue past any of them is refused.", shows: "The contract rejects the call, and a position may stay below its target." },
  { condition: "Wrong nonce", result: "The contract cannot see the EVM nonce. A wrong nonce wastes budget and can move value nowhere else.", shows: "The signed transaction does not land." },
  { condition: "The price keeps falling", result: "A repay lowers debt, and the position stays open. A large enough fall still reaches liquidation.", shows: "A later rescue, or a liquidation once caps run out." },
];

const FAILURE_COLUMNS: Column<FailureCondition>[] = [
  { label: "Condition", cell: (row) => row.condition },
  { label: "What happens", plain: true, cell: (row) => row.result },
  { label: "What you see", plain: true, cell: (row) => row.shows },
];

interface Phase {
  phase: string;
  state: string;
  scope: string;
}

const PHASES: Phase[] = [
  { phase: "Core", state: "Built, on testnet", scope: "Aave v3 on Base and Arbitrum, USDC debt, the NEAR contract, a Chain Signatures rescuer address, a deterministic keeper, this public tool and the evidence folder." },
  { phase: "Reserve", state: "Not built", scope: "An off-venue reserve in a NEAR Intents Agent API wallet with pinned destinations. It needs partner access. The dry quote above is the route it would use." },
  { phase: "Hyperliquid", state: "Not built", scope: "Cross-margin top-ups up to a loss limit you set. A separate gate, outside the core. Isolated positions would stay uncovered, because a credit to the account does not reach isolated margin." },
  { phase: "Mainnet", state: "Not deployed", scope: "No mainnet contract yet, and no audit. On mainnet every full-access key is deleted after deployment, so there is no admin and no upgrade path." },
];

const PHASE_COLUMNS: Column<Phase>[] = [
  { label: "Phase", cell: (row) => row.phase },
  { label: "State", cell: (row) => row.state },
  { label: "Scope", plain: true, cell: (row) => row.scope },
];

const LIMITS = [
  "Unaudited. Don’t use it with funds you can’t lose.",
  "A liquidator can win the race, the reserve can run out, and the MPC network can be down.",
  "The contract cannot read the lending chain, so the trigger lives in an off-chain keeper. If the keeper stops, nothing fires.",
  "The MPC network is trusted with custody of the rescuer key.",
  "USDC debt only, on Aave v3 on Base and Arbitrum. A position with debt in anything else cannot be repaid.",
  "Every live run so far is on testnet, from one position. Nothing has been measured on a mainnet or during a crash.",
  "Nothing here promises that a position will survive.",
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
        "dropToLiquidation": { "fraction": 0.12, "formula": "1 - 1/HF", "assumptionHolds": true },
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
    "marginRatio": 3.01,         // equity / maintenance, null if not worked out
    "pools": [],
    "positions": [
      { "market": "BTC", "margin": "cross", "liquidationPrice": 0, "distance": 0.91, "covered": true }
    ]
  }
}`;

export default function HowPage() {
  const { hops, overall, counts } = PROOF;

  return (
    <main id="main">
      <div className="page-head">
        <p className="lines">
          <Badge lane="P" size="s" />
          <Badge lane="K" size="s" />
          <Badge lane="N" size="s" />
          <Badge lane="M" size="s" />
          <span className="t">Four lines, one terminus</span>
        </p>
        <h1>How a rescue runs</h1>
        <p className="lede">Levee repays your Aave debt from a reserve when your health factor crosses a trigger you set. The position stays in your wallet, and the keeper can’t send funds anywhere else. This is the whole line, as specified and as measured on testnet.</p>
      </div>

      <section className="s s-tint s-first" aria-labelledby="line-h">
        <div className="sh">
          <h2 className="big" id="line-h">
            The line, stop by stop
          </h2>
          <p>Times are medians from the {overall.samples} testnet runs that landed. The dashed stop is planned and not built, and its quote below is live.</p>
        </div>
        <div className="how-grid">
          <StopLine after={{ 6: <RouteQuotePanel from="arbitrum" to="base" amount={20} /> }} />
          {PROOF.replay && <TimeBar replay={PROOF.replay} />}
        </div>
        <Terminus />
      </section>

      <section className="s" aria-labelledby="repay-h">
        <div className="sh">
          <h2 className="big" id="repay-h">
            The repay is one formula
          </h2>
          <p>To reach target T, with collateral C in USD, liquidation threshold L and debt D.</p>
        </div>
        <p className="formula">
          <code>R = D - (C * L) / T</code>
        </p>
        <p className="prose">The keeper converts R to USDC at Aave’s oracle price, rounding up, and adds 2 base units, because Aave rounds the debt it burns down. The trigger, the target and the RPC list live off chain. No language model is involved.</p>
      </section>

      <section className="s s-tint" id="who" aria-labelledby="who-h">
        <div className="sh">
          <h2 className="big" id="who-h">
            Who can do what
          </h2>
          <p>Each line has one job. The contract enforces the limits, so a stolen keeper key stays inside them.</p>
        </div>
        <Boards />
        <WorstCase />
        <h3 className="sub">What a stolen keeper key cannot do</h3>
        <TextTable columns={ATTEMPT_COLUMNS} rows={ATTEMPTS} rowKey={(row) => row.attempt} label="What a stolen keeper key tries" />
        <p className="note-line">These are the contract’s rules as specified in docs/SPEC.md. Caps bound what gets signed. A signature already issued stays valid until its nonce is used, and it can still only repay the registered borrower’s debt.</p>
      </section>

      <section className="s" id="fails" aria-labelledby="fails-h">
        <div className="sh">
          <h2 className="big" id="fails-h">
            When it fails
          </h2>
          <p>A rescue is a race, and it can be lost. These are the conditions we know of.</p>
        </div>
        <TextTable columns={FAILURE_COLUMNS} rows={FAILURES} rowKey={(row) => row.condition} label="Failure conditions" />
      </section>

      <section className="s s-tint" id="measured" aria-labelledby="measured-h">
        <div className="sh">
          <h2 className="big" id="measured-h">
            Measured on testnet
          </h2>
          <p>
            {overall.samples} full runs on {joined(counts.chains)}, from {counts.positions === 1 ? "one position" : `${counts.positions} positions`}. With this few runs the p95 is the slowest run. Nothing here has been measured on a mainnet or during a crash.
          </p>
        </div>
        <MeasuredTable hops={hops} overall={overall} />
        <p className="note-line">
          Every run, with its transactions, is on <Link href="/proof">the proof page</Link>.
        </p>
      </section>

      <section className="s" id="built" aria-labelledby="built-h">
        <div className="sh">
          <h2 className="big" id="built-h">
            What is not built yet
          </h2>
          <p>The core runs on testnet. The rest is planned, and this page says so where it appears.</p>
        </div>
        <TextTable columns={PHASE_COLUMNS} rows={PHASES} rowKey={(row) => row.phase} label="Phases" />
      </section>

      <section className="s s-tint" id="limits" aria-labelledby="limits-h">
        <div className="sh">
          <h2 className="big" id="limits-h">
            Limits
          </h2>
        </div>
        <ul className="prose-list">
          {LIMITS.map((limit) => (
            <li key={limit}>{limit}</li>
          ))}
        </ul>
      </section>

      <section className="s" id="distance" aria-labelledby="distance-h">
        <div className="sh">
          <h2 className="big" id="distance-h">
            How to read a distance
          </h2>
          <p>The address tool places every position on one line by the price move that would liquidate it.</p>
        </div>
        <p className="prose">The order is a percentage move in price. It says nothing about likelihood: a 12% fall in WETH and a 43% rise in AERO share one line, and they are not equally likely.</p>
        <p className="prose">
          On Aave the distance is <code>1 - 1/HF</code>. It holds for volatile collateral against stable debt, when all collateral falls together and the debt keeps its value. The tool checks what each position holds and says when that is not the case. A wstETH position against WETH debt, for one, moves only when one asset moves against the other.
        </p>
        <p className="prose">Repay figures use Aave oracle prices and assume no further price move. Levee repays USDC debt only, so the tool shows how much of a repay USDC debt can cover. A grey ring is a position Levee cannot reach.</p>
        <p className="prose">
          On Hyperliquid, margin ratio is equity divided by maintenance margin, and liquidation is at 1.00. The account mode, from <code>userAbstraction</code>, decides where equity is read. Unified accounts keep it in the spot balance. Portfolio margin needs borrow caps and oracle prices, so those positions show without a ratio.
        </p>
        <p className="prose">For scale: the worst 15-minute drops on 2025-10-10 were 11.74% for BTC, 13.02% for ETH and 28.8% for SOL, on Binance perpetual futures.</p>
      </section>

      <section className="s s-tint" id="api" aria-labelledby="api-h">
        <div className="sh">
          <h2 className="big" id="api-h">
            The same data as JSON
          </h2>
          <p>
            <code>GET /api/risk?address=0x...&amp;target=1.5</code> returns what the reading page shows. No key is needed.
          </p>
        </div>
        <p className="prose">The target is optional, from 1.05 to 3. Results are cached for up to 15 seconds, or 5 when some figures are missing, and one connection can make 30 reads a minute.</p>
        <p className="prose">
          A bad address or target returns 400 with <code>error.code</code>. Past the limit it returns 429. If no source answers, the same shape comes back with status 503. A null is a missing figure, and it stays null. The shape below is shortened, and <code>schema</code> changes only when a field is removed or changes meaning.
        </p>
        <div className="scroll code-block" tabIndex={0} role="region" aria-label="Example response">
          <pre>
            <code>{API_EXAMPLE}</code>
          </pre>
        </div>
      </section>
    </main>
  );
}
