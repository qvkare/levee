import type { Metadata } from "next";
import { StageTable } from "@/components/stage-table.tsx";
import { StackTable, type Column } from "@/components/stack-table.tsx";

export const metadata: Metadata = {
  title: "How it works",
  description: "How a Levee rescue runs, who can do what, and the conditions under which it fails.",
};

interface Actor {
  actor: string;
  role: string;
  can: string;
  cannot: string;
}

const ACTORS: Actor[] = [
  {
    actor: "Owner",
    role: "NEAR account",
    can: "Register, set caps, pause, and withdraw float to the registered borrower.",
    cannot: "Be bypassed by the keeper.",
  },
  {
    actor: "Keeper",
    role: "NEAR function-call key limited to rescue",
    can: "Ask the contract to sign a repay within caps. Fire early.",
    cannot: "Change the destination, the asset or the borrower. Exceed caps. Withdraw.",
  },
  {
    actor: "Levee contract",
    role: "NEAR contract",
    can: "Sign approve, repay and transfer to fixed targets.",
    cannot: "Sign arbitrary payloads. It has no admin and no full-access key on mainnet.",
  },
  {
    actor: "MPC network",
    role: "v1.signer",
    can: "Sign for the derived address. It is trusted for custody of the rescuer key.",
    cannot: "Levee places no limit on it. This trust is not removed.",
  },
  {
    actor: "Aave Pool",
    role: "Aave v3 on Base or Arbitrum",
    can: "Pull USDC the rescuer approved.",
    cannot: "Pull more than the allowance, which is at most 30 days of the daily cap.",
  },
];

const ACTOR_COLUMNS: Column<Actor>[] = [
  {
    label: "Who",
    cell: (row) => (
      <>
        <span className="medium">{row.actor}</span>
        <br />
        <span className="muted small">{row.role}</span>
      </>
    ),
  },
  { label: "Can", wide: true, cell: (row) => row.can },
  { label: "Cannot", wide: true, cell: (row) => row.cannot },
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
  { condition: "A liquidator wins the race", result: "The price can reach flood stage before a rescue is included. Liquidators act first and the collateral is sold.", shows: "The run is recorded as failed, with its timings." },
  { condition: "Keeper down", result: "The trigger lives in the keeper, off chain. The contract cannot read the lending chain, so nothing fires without a keeper.", shows: "No run at all. Silence is a failure too." },
  { condition: "RPC endpoints disagree", result: "The keeper acts only when two endpoints agree within 0.5% and are under 30 seconds old.", shows: "The keeper holds until they agree, which spends time." },
  { condition: "A cap is reached", result: "Per-rescue cap, daily cap and cooldown are checked by the contract. A rescue past any of them is refused.", shows: "The contract rejects the call, and a position may stay below its target." },
  { condition: "Wrong nonce", result: "The contract cannot see the EVM nonce. A wrong nonce wastes budget, but cannot move value anywhere else.", shows: "The signed transaction does not land." },
  { condition: "The price keeps falling", result: "A repay lowers debt, but the position stays open. A large enough fall still reaches flood stage.", shows: "A later rescue, or a liquidation once caps run out." },
];

const FAILURE_COLUMNS: Column<FailureCondition>[] = [
  { label: "Condition", cell: (row) => <span className="medium">{row.condition}</span> },
  { label: "What happens", wide: true, cell: (row) => row.result },
  { label: "What you see", wide: true, cell: (row) => row.shows },
];

const PHASES = [
  { phase: "Core", scope: "Aave v3 on Base and Arbitrum, USDC debt, NEAR contract, Chain Signatures rescuer address, deterministic keeper, this public tool, evidence." },
  { phase: "Reserve", scope: "An off-venue reserve in a NEAR Intents Agent API wallet with pinned destinations. Needs partner access." },
  { phase: "Hyperliquid", scope: "Cross-margin top-ups up to a loss limit you set. A separate gate, not part of the core, and not live." },
];

const API_EXAMPLE = `{
  "schema": "levee.risk.v1",
  "address": "0x...",            // EIP-55
  "generatedAt": "...",          // ISO 8601, UTC
  "status": "ok",                // ok, partial or unavailable
  "target": 1.5,                 // health factor used for repay
  "failures": [],                // what is missing, and why
  "nearest": { "venue": "aave.base", "stage": "action", "fall": 0.05 },
  "aave": {
    "base": {
      "status": "ok",
      "blockNumber": "...",      // every figure was read at this block
      "position": {
        "healthFactor": 1.05,    // null with no debt
        "collateralUsd": 0,
        "debtUsd": 0,
        "liquidationThreshold": 0.95,
        "dropToLiquidation": {
          "fraction": 0.05,
          "formula": "1 - 1/HF",
          "assumption": "...",
          "assumptionHolds": false,
          "note": "..."
        },
        "repay": { "target": 1.5, "usd": 0, "usdcDebtUsd": 0, "usdcCovers": false },
        "reserves": { "collateral": [], "debt": [], "liquidationBonus": 0.05 },
        "raw": { "healthFactor": "..." }   // exact contract outputs
      }
    },
    "arbitrum": {}
  },
  "hyperliquid": {
    "status": "ok",
    "mode": "unified",           // standard, unified, portfolio, dex-abstraction or unknown
    "marginRatio": 3.2,          // equity / maintenance, null if not computed
    "pools": [],
    "positions": [
      { "market": "BTC", "margin": "cross", "liquidationPrice": 0, "distance": 0.12, "covered": true }
    ]
  }
}`;

export default function HowPage() {
  return (
    <div className="wrap">
      <section className="page-head">
        <h1>A keeper watches the stage. A contract signs the repay, within caps you set.</h1>
        <p>
          Levee repays a borrower&apos;s debt from a reserve when their health factor crosses a trigger they set. The position stays in the borrower&apos;s wallet. The keeper cannot send funds anywhere else.
        </p>
        <p>
          <span className="medium">Unaudited, and a working draft.</span> Do not use it with funds you cannot lose. Nothing described here is a promise that a position will survive.
        </p>
      </section>

      <section className="page-section">
        <h2>How a rescue runs</h2>
        <ol className="steps">
          <li>The keeper reads your health factor from at least two RPC endpoints, every 5 seconds. It acts only if they agree within 0.5% and are under 30 seconds old.</li>
          <li>If health factor is below your trigger, it works out the repay that reaches your target, capped by the position, the rescuer&apos;s USDC balance and the debt.</li>
          <li>It reads the rescuer&apos;s nonce and fees, and calls rescue on the NEAR contract with a function-call key.</li>
          <li>The contract checks caps, cooldown and fee ceilings, then builds the transaction itself. The keeper supplies no calldata, target or payload.</li>
          <li>The contract asks the NEAR MPC network to sign for the rescuer address derived for your position.</li>
          <li>The keeper checks the recovered address, broadcasts the signed transaction, and Aave applies the repay to your debt.</li>
          <li>The keeper reads health factor again and writes a record to evidence, whether the run worked or not.</li>
        </ol>
        <div className="prose">
          <p>The repay needed to reach target T, with collateral C in USD, liquidation threshold L and debt D:</p>
          <p className="formula">
            <code>R = D - (C * L) / T</code>
          </p>
          <p>The trigger, target and RPC list live off chain. No LLM is involved.</p>
        </div>
      </section>

      <section className="page-section">
        <h2>Who can do what</h2>
        <StackTable columns={ACTOR_COLUMNS} rows={ACTORS} rowKey={(row) => row.actor} />
        <div className="prose">
          <p>The worst a stolen keeper key can do is repay the borrower&apos;s debt early, burn rescuer gas up to the fee ceiling, or burn the daily budget.</p>
          <p>The contract cannot read the lending chain, so it does not know the health factor. The trigger is kept by the keeper, off chain. Caps bound what any trigger can do.</p>
        </div>
      </section>

      <section id="fails" className="page-section">
        <h2>When it fails</h2>
        <div className="prose">
          <p>A rescue is a race, and it can be lost. These are the conditions we know of.</p>
        </div>
        <StackTable columns={FAILURE_COLUMNS} rows={FAILURES} rowKey={(row) => row.condition} />
      </section>

      <section className="page-section">
        <h2>Reading the gauge</h2>
        <StageTable />
        <div className="prose">
          <p>For scale: the worst 15-minute drops on 2025-10-10 were 11.74% for BTC, 13.02% for ETH and 28.8% for SOL, on Binance perpetual futures.</p>
          <p>
            Approximate fall to liquidation is <code>1 - 1/HF</code>. It holds for volatile collateral against stable debt: all collateral falls together and the debt keeps its value. The tool checks what each position holds, and says when that is not the case.
            A wstETH position against WETH debt, for one, does not care about a market fall, only about one asset falling against the other.
          </p>
          <p>
            Repay figures use Aave oracle prices and assume no further price move. Levee repays USDC debt only, so the tool shows how much of a repay USDC debt can cover.
          </p>
          <p>
            On Hyperliquid, margin ratio is equity divided by maintenance margin, and liquidation is at 1.00. The account mode, from <code>userAbstraction</code>, decides where equity is read. Unified accounts keep it in the spot balance, so per-DEX state alone would understate it.
            Portfolio margin uses a different rule that needs borrow caps and oracle prices, so the tool shows those positions without a ratio. Isolated positions are not covered, because a credit to the account does not reach isolated margin.
          </p>
        </div>
      </section>

      <section className="page-section">
        <h2>What is in each phase</h2>
        <StackTable columns={[{ label: "Phase", cell: (row) => <span className="medium">{row.phase}</span> }, { label: "Scope", wide: true, cell: (row) => row.scope }]} rows={PHASES} rowKey={(row) => row.phase} />
      </section>

      <section id="api" className="page-section">
        <h2>The same data as JSON</h2>
        <div className="prose">
          <p>
            <code>GET /api/risk?address=0x...&amp;target=1.5</code> returns what the report page shows. There is no key. The target is optional, from 1.05 to 3. Results are cached for up to 15 seconds, or 5 when some figures are missing.
          </p>
          <p>
            A bad address or target returns 400 with <code>error.code</code>. If no source answers, the same shape comes back with status 503. A null means the figure is missing, not zero. The shape below is shortened, and <code>schema</code> changes only when a field is removed or changes meaning.
          </p>
        </div>
        <pre>
          <code>{API_EXAMPLE}</code>
        </pre>
      </section>
    </div>
  );
}
