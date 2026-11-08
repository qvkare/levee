import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/badge.tsx";
import { Boards, WorstCase } from "@/components/boards.tsx";
import { MeasuredTable } from "@/components/measured-table.tsx";
import { RouteQuotePanel } from "@/components/route-quote.tsx";
import { ReserveTerminus, StopLine, Terminus } from "@/components/stops.tsx";
import { TextTable, type Column } from "@/components/text-table.tsx";
import { TimeBar } from "@/components/time-bar.tsx";
import { countWord, joined } from "@/lib/format.ts";
import { PROOF } from "@/lib/proof.ts";
import { SCHEMA } from "@/lib/types.ts";

/** Built once. The measured hops come from the run records, inlined at build time. */
export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "How a rescue runs",
  description: "How Levee repays Aave debt from the borrower's own collateral, stop by stop: the helper's checks on chain, who can do what, when it fails, what has been measured, the reserve as a second mode, and what is not built yet.",
};

interface Attempt {
  attempt: string;
  rule: string;
}

const ATTEMPTS: Attempt[] = [
  { attempt: "Sell while you are above the trigger", rule: "LeveeUnwind reads your health factor from Aave before anything moves, and reverts at or above the trigger you set (AboveTrigger)." },
  { attempt: "Sell other collateral, or in another pool", rule: "The collateral and pool fee are fixed at registration on NEAR, and the helper checks them against your authorize on Base (TermsMismatch)." },
  { attempt: "Sell past your price bound", rule: "Each sale must be within your bound against Aave’s oracle (SlippageExceeded) and within max_sold (MaxSoldExceeded). The keeper can raise max_sold only up to your bound." },
  { attempt: "Sell far past your target", rule: "After the sale, health factor must have risen and must not pass far beyond your target (NoImprovement, OverSold)." },
  { attempt: "Send funds anywhere else", rule: "rescue_from_collateral takes a position id, an amount, max_sold and fees. The contract writes the call itself, unwind repays only your USDC debt, and the sold collateral goes straight to the pool. Nothing stays in the helper." },
  { attempt: "Change the code", rule: "Neither contract account on NEAR has a key left. LeveeUnwind has no owner, no admin method and no upgrade." },
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

/** Collateral runs the keeper stopped itself, because the quote was past the borrower's bound. */
const refusedOnBound = PROOF.runs.filter((run) => run.mode === "collateral" && run.outcome === "aborted" && run.reason?.startsWith("quote_over_slippage_bound")).length;

/** Backtest periods where a refused or unfillable sale was the commonest reason a liquidated position was missed. */
const boundTops = (PROOF.backtest?.periods ?? []).filter((period) => period.bounds[0]?.misses[0]?.reason === "slippage_cap").map((period) => period.range);

const FAILURES: FailureCondition[] = [
  {
    condition: "The pool is too thin or off the oracle",
    result: "The sale would pass your bound, so the keeper sends nothing. If the pool moves after the quote, unwind reverts and only gas is spent.",
    shows: `An aborted run, quote_over_slippage_bound.${refusedOnBound > 0 ? ` ${countWord(refusedOnBound)} testnet ${refusedOnBound === 1 ? "run" : "runs"} stopped this way.` : ""}${boundTops.length > 0 ? ` In the backtest it was the commonest reason a liquidated position was missed in ${joined(boundTops)}.` : ""}`,
  },
  { condition: "A liquidator wins the race", result: "A move can outrun the rescue, and a liquidator can act first once health factor reaches 1.00.", shows: "The run is recorded as failed, with its timings." },
  { condition: "Another collateral at LTV 0", result: "Aave refuses the aToken transfer of any collateral with a non-zero LTV, so every unwind would fail.", shows: "The keeper records ltv_zero_collateral and sends nothing. Withdraw or disable that asset." },
  { condition: "Collateral paused, or the sequencer down", result: "The helper refuses paused or inactive collateral, and refuses while Aave’s price oracle sentinel stops liquidations.", shows: "unwind reverts, and nothing moves." },
  { condition: "NEAR, the MPC network or the RPCs down", result: "With no signature, or no agreed read, nothing is sent.", shows: "A rescue_failed event on NEAR, or no run at all." },
  { condition: "Keeper down", result: "The trigger is read by the keeper. If it stops, nothing fires.", shows: "No run at all. Silence is a failure too." },
  { condition: "RPCs disagree", result: "The keeper acts only when two endpoints agree within 0.5% and are under 30 seconds old.", shows: "The keeper holds until they agree. One reserve-mode run stopped this way." },
  { condition: "Allowance used up, or no gas", result: "The aToken allowance to the helper caps what it can sell, and the rescuer pays gas.", shows: "unwind reverts, or the transaction cannot be paid for." },
  { condition: "A cap is reached", result: "Per-rescue cap, daily cap and cooldown are checked by the contract. A rescue past any of them is refused.", shows: "The contract rejects the call, and a position may stay below its target." },
  { condition: "Reserve mode: the reserve runs out", result: "There is no USDC at the rescuer to repay with.", shows: "Applies only to the second mode." },
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

function phases(): Phase[] {
  const collateral = PROOF.modes.collateral.counts;
  const reserve = PROOF.modes.reserve.counts;
  const tally = (landed: number, aborted: number) => `${landed} rescues${aborted ? ` and ${aborted} ${aborted === 1 ? "run" : "runs"} the keeper stopped` : ""}`;
  return [
    { phase: "Repay from collateral", state: "Built, live on testnet", scope: `The main mode. LeveeUnwind on Base Sepolia and Levee v0.2 on NEAR testnet: ${tally(collateral.success, collateral.aborted)}.` },
    { phase: "Repay from a reserve", state: "Built, live on testnet", scope: `The second mode, from USDC held at the rescuer. Levee v0.1 on NEAR testnet: ${tally(reserve.success, reserve.aborted)}.` },
    { phase: "Arbitrum", state: "Built, no live runs", scope: "The contracts support it, and fork tests cover both modes there." },
    { phase: "Reserve layer", state: "Not built", scope: "An off-venue reserve in a NEAR Intents Agent API wallet with pinned destinations. It needs partner access. The dry quote above is the route it would use." },
    { phase: "Hyperliquid", state: "Not built", scope: "The site reads Hyperliquid, but Levee does not act on it. Isolated positions would stay uncovered, because a credit to the account does not reach isolated margin." },
    { phase: "Mainnet", state: "Not deployed", scope: "No mainnet contract, no external audit and no reproducible build yet. On mainnet the last full-access key is deleted after deployment, as it was on both testnet contracts." },
  ];
}

const PHASE_COLUMNS: Column<Phase>[] = [
  { label: "Phase", cell: (row) => row.phase },
  { label: "State", cell: (row) => row.state },
  { label: "Scope", plain: true, cell: (row) => row.scope },
];

const LIMITS = [
  "A liquidator can win the race, a pool can be too thin for the sale, and the MPC network can be down.",
  "The NEAR contract cannot read the lending chain, so an off-chain keeper reads the trigger, and the helper checks it again on chain. If the keeper stops, nothing fires.",
  "The MPC network is trusted with custody of the rescuer key.",
  "USDC debt only, on Aave v3 on Base and Arbitrum, sold in one Uniswap v3 pool per position. Borrowers in eMode are not sized correctly yet.",
  "Every live run so far is on testnet, from one position, and the collateral runs sold into a pool the team seeded at Aave’s oracle price. Nothing has been measured on a mainnet or during a crash.",
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

/** Where the six landed, against the target they aimed for. */
function landedLine(): string {
  const { landedHealth, target, timing } = PROOF.modes.collateral;
  if (!landedHealth || target === null) return "";
  return ` The ${timing.overall.samples} testnet rescues aimed at ${target.toFixed(2)} and landed at ${landedHealth.low.toFixed(3)} to ${landedHealth.high.toFixed(3)}.`;
}

export default function HowPage() {
  const { modes, counts } = PROOF;
  const collateral = modes.collateral.timing.overall;

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
        <p className="lede">Levee repays your Aave debt from your own collateral when your health factor falls below a trigger you set. The position stays in your wallet, and every sale is checked on chain against your trigger and your price bound. This is the whole line, as specified and as measured on testnet.</p>
      </div>

      <section className="s s-tint s-first" aria-labelledby="line-h">
        <div className="sh">
          <h2 className="big" id="line-h">
            The line, stop by stop
          </h2>
          <p>Times are medians from the {collateral.samples} testnet rescues from collateral. The square stop is the helper, LeveeUnwind, on the lending chain.</p>
        </div>
        <div className="how-grid">
          <StopLine />
          {PROOF.replay && <TimeBar replay={PROOF.replay} median={{ p50Ms: collateral.p50Ms, samples: collateral.samples }} />}
        </div>
        <Terminus />
      </section>

      <section className="s" aria-labelledby="repay-h">
        <div className="sh">
          <h2 className="big" id="repay-h">
            The repay is one formula
          </h2>
          <p>To reach target T with debt D and borrowing capacity C × L, selling a collateral with liquidation threshold L_c at a total cost s, all in Aave’s base currency.</p>
        </div>
        <p className="formula">
          <code>R = (T × D − C × L) / (T − L_c × (1 + s))</code>
        </p>
        <p className="prose">
          The keeper takes s as the pool fee plus your bound. The bound already includes the fee, so this counts it twice, and the keeper lands slightly above target.{landedLine()} The helper’s bound allows exactly this. R is capped by your caps and your USDC debt, and the collateral it implies must fit your aToken balance and allowance. The trigger, the target and the RPC list are read from the helper and the keeper’s config. No language model is involved.
        </p>
      </section>

      <section className="s s-tint" id="who" aria-labelledby="who-h">
        <div className="sh">
          <h2 className="big" id="who-h">
            Who can do what
          </h2>
          <p>Each actor has one job. The helper on Base and the contract on NEAR enforce the limits, so a stolen keeper key stays inside them.</p>
        </div>
        <Boards />
        <WorstCase />
        <h3 className="sub">What a stolen keeper key cannot do</h3>
        <TextTable columns={ATTEMPT_COLUMNS} rows={ATTEMPTS} rowKey={(row) => row.attempt} label="What a stolen keeper key tries" />
        <p className="note-line">These are the rules in docs/SPEC.md, sections 2 and 9, and the claims ledger ties each to a test. Caps bound what gets signed. A signature already issued stays valid until its nonce is used, and it can still only repay the registered borrower’s debt.</p>
      </section>

      <section className="s" id="different" aria-labelledby="different-h">
        <div className="sh">
          <h2 className="big" id="different-h">
            What is different
          </h2>
          <p>Levee is one of several ways to protect a position in place. DeFi Saver protects Aave v3 positions held in an EOA on Base and Arbitrum, through a Safe operator and an aToken approval.</p>
        </div>
        <ul className="prose-list">
          <li>The helper, LeveeUnwind, has no owner and cannot be upgraded. The borrower gives it a capped aToken allowance and nothing else: no Safe, no module, no credit delegation.</li>
          <li>The trigger is checked on chain, and the sale price is bounded against Aave’s oracle on chain, by the helper.</li>
          <li>One NEAR policy can control rescuers on several chains through Chain Signatures, in a contract with no keys.</li>
          <li>Levee swaps in one Uniswap v3 pool, and there is no mainnet data, so it claims nothing about cost or execution against other tools.</li>
        </ul>
      </section>

      <section className="s s-tint" id="fails" aria-labelledby="fails-h">
        <div className="sh">
          <h2 className="big" id="fails-h">
            When it fails
          </h2>
          <p>A rescue is a race, and it can be lost. These are the conditions we know of.</p>
        </div>
        <TextTable columns={FAILURE_COLUMNS} rows={FAILURES} rowKey={(row) => row.condition} label="Failure conditions" />
      </section>

      <section className="s" id="measured" aria-labelledby="measured-h">
        <div className="sh">
          <h2 className="big" id="measured-h">
            Measured on testnet
          </h2>
          <p>
            Every run on {joined(counts.chains)}, from {counts.positions === 1 ? "one position" : `${counts.positions} positions`}. With this few runs the p95 is the slowest run. The keeper also reads every 5 seconds, which this table does not include. Nothing here has been measured on a mainnet or during a crash.
          </p>
        </div>
        <MeasuredTable modes={[modes.collateral, modes.reserve]} />
        <p className="note-line">
          Every run, with its transactions, is on <Link href="/proof">the proof page</Link>.
        </p>
      </section>

      <section className="s s-tint" id="reserve" aria-labelledby="reserve-h">
        <div className="sh">
          <h2 className="big" id="reserve-h">
            The second mode: repay from a reserve
          </h2>
          <p>The same keeper and contract can repay from USDC held at the rescuer, with no collateral sold. The backtest found that the same USDC repaid upfront protects one position as well as a reserve, so the reserve is the second mode. Its last stop is planned, and its quote is live.</p>
        </div>
        <div className="how-grid">
          <StopLine mode="reserve" after={{ 3: <RouteQuotePanel from="arbitrum" to="base" amount={20} /> }} />
        </div>
        <ReserveTerminus />
        <p className="formula">
          <code>R = D - (C * L) / T</code>
        </p>
        <p className="prose">In this mode the keeper converts R to USDC at Aave’s oracle price, rounding up, and adds 2 base units, because Aave rounds the debt it burns down.</p>
      </section>

      <section className="s" id="built" aria-labelledby="built-h">
        <div className="sh">
          <h2 className="big" id="built-h">
            What is not built yet
          </h2>
          <p>Both modes run on testnet. The rest is built and untested live, or planned, and this page says which.</p>
        </div>
        <TextTable columns={PHASE_COLUMNS} rows={phases()} rowKey={(row) => row.phase} label="Phases" />
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
