import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPosition } from "./aave-model.ts";
import { CHAINS } from "./chains.ts";
import { buildAccount, NO_ACCOUNT } from "./hyperliquid-model.ts";
import { chartModel, verdict } from "./reading.ts";
import { assembleReport, withTarget } from "./report.ts";
import type { AaveMarket, AavePosition, ChainKey, HyperliquidAccount, RiskReport } from "./types.ts";

const USDC = CHAINS.base.usdc;
const NO_DEBT = 2n ** 256n - 1n;

function market(chain: ChainKey, position: AavePosition | null, status: AaveMarket["status"] = "ok"): AaveMarket {
  return { status, chain, chainId: CHAINS[chain].chainId, pool: CHAINS[chain].pool, blockNumber: status === "unavailable" ? null : "1", blockTimestamp: null, position };
}

/** A position with the given health factor, on $1,000 of collateral and an 80% threshold. */
function borrower(health: number): AavePosition {
  const debtBase = BigInt(Math.round((80_000_000_000 / health) * 1));
  const position = buildPosition([100_000_000_000n, debtBase, 0n, 8000n, 7500n, BigInt(Math.round(health * 1e6)) * 10n ** 12n], null, USDC, 1.5);
  assert.ok(position);
  return position;
}

const emptyHl: HyperliquidAccount = { ...NO_ACCOUNT, status: "ok", mode: "standard" };

function report(parts: Partial<{ base: AaveMarket; arbitrum: AaveMarket; hyperliquid: HyperliquidAccount; failures: RiskReport["failures"] }>): RiskReport {
  return assembleReport({
    address: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    target: 1.5,
    generatedAt: "2026-11-07T00:00:00.000Z",
    base: market("base", null),
    arbitrum: market("arbitrum", null),
    hyperliquid: emptyHl,
    failures: [],
    ...parts,
  });
}

test("a clean address is dry, and says so", () => {
  const result = report({});
  assert.equal(result.status, "ok");
  assert.equal(result.nearest, null);
  assert.equal(chartModel(result).state, "dry");
  assert.match(verdict(result).text, /^Dry\. No Aave position/);
});

test("collateral with no debt is dry", () => {
  const position = buildPosition([100_000_000_000n, 0n, 0n, 8000n, 7500n, NO_DEBT], null, USDC, 1.5);
  const result = report({ base: market("base", position) });
  assert.equal(chartModel(result).state, "dry");
  assert.match(verdict(result).text, /collateral on Aave but no debt/);
});

test("the nearest reading sets the water, and both show on the staff", () => {
  const result = report({ base: market("base", borrower(1.2)), arbitrum: market("arbitrum", borrower(2)) });
  assert.equal(result.nearest?.venue, "aave.base");
  assert.equal(result.nearest?.stage, "action");
  const model = chartModel(result);
  assert.equal(model.state, "reading");
  assert.equal(model.marks.length, 2);
  assert.equal(model.marks[0]?.id, "base");
  assert.ok(Math.abs((model.waterFall as number) - (1 - 1 / 1.2)) < 1e-6);
  assert.match(verdict(result).text, /Aave on Base is nearest flood stage, at health factor 1\.200/);
});

test("below 1.00 goes over the levee and names the state", () => {
  const result = report({ base: market("base", borrower(0.97)) });
  assert.equal(result.nearest?.stage, "flood");
  assert.equal(chartModel(result).state, "over");
  const answer = verdict(result);
  assert.equal(answer.stage, "flood");
  assert.match(answer.text, /^Over flood stage\. Aave on Base reads health factor 0\.970/);
});

test("a Hyperliquid position can be the nearest reading", () => {
  const hyperliquid = buildAccount({
    abstraction: "default",
    spot: null,
    dexes: [
      {
        dex: "",
        collateralToken: 0,
        state: {
          crossMarginSummary: { accountValue: "50" },
          crossMaintenanceMarginUsed: "5",
          time: 1,
          assetPositions: [{ position: { coin: "BTC", szi: "1", entryPx: "100", positionValue: "100", unrealizedPnl: "0", liquidationPx: "95", marginUsed: "10", leverage: { type: "cross", value: 10 } } }],
        },
      },
    ],
  });
  const result = report({ base: market("base", borrower(2)), hyperliquid });
  assert.equal(result.nearest?.venue, "hyperliquid");
  assert.match(verdict(result).text, /^Hyperliquid BTC long is nearest flood stage: 5\.0% from its liquidation price/);
});

test("a dead source is partial, says so, and is not read as dry", () => {
  const result = report({
    base: market("base", null, "unavailable"),
    failures: [{ source: "aave.base", message: "Base RPC did not answer. Base figures are missing, not zero." }],
  });
  assert.equal(result.status, "partial");
  assert.match(verdict(result).text, /not the whole picture/);
});

test("nothing answering is out of service, not dry", () => {
  const result = report({ base: market("base", null, "unavailable"), arbitrum: market("arbitrum", null, "unavailable"), hyperliquid: NO_ACCOUNT });
  assert.equal(result.status, "unavailable");
  assert.equal(chartModel(result).state, "out");
  assert.match(verdict(result).text, /^No gauge answered/);
});

test("changing the target changes only the repay figures", () => {
  const result = report({ base: market("base", borrower(1.25)) });
  const moved = withTarget(result, 2);
  assert.equal(moved.target, 2);
  assert.ok(Math.abs((moved.aave.base.position?.repay?.usd as number) - (640 - 400)) < 0.01);
  assert.equal(moved.aave.base.position?.healthFactor, result.aave.base.position?.healthFactor);
  assert.equal(moved.aave.arbitrum, result.aave.arbitrum);
});
