import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPosition } from "./aave-model.ts";
import { CHAINS } from "./chains.ts";
import { NO_ACCOUNT } from "./hyperliquid-model.ts";
import { buildLine, crisisFor, figuresFor, pointsFor, restLines, scaleAt, triggerDistance, unplacedLine, unreadLine, type LineEntry } from "./line.ts";
import { assembleReport } from "./report.ts";
import type { AaveMarket, AavePosition, ChainKey, HyperliquidAccount, PerpPosition, ReserveLine, Reserves, RiskReport } from "./types.ts";
import { applyFall, parseFall } from "./what-if.ts";

const USDC = CHAINS.base.usdc;
const WETH = "0x4200000000000000000000000000000000000006";

const line = (symbol: string, asset: string, usd: number, stable: boolean): ReserveLine => ({ asset, symbol, amount: usd, usd, stable });

const reserves = (collateral: ReserveLine[], debt: ReserveLine[]): Reserves => ({ collateral, debt, eModeCategory: 0, liquidationBonus: 0.05 });

/** $1,000 of collateral at an 80% threshold. */
function borrower(health: number, debt: ReserveLine[] = [line("USDC", USDC, 800 / health, true)], collateral: ReserveLine[] = [line("WETH", WETH, 1000, false)]): AavePosition {
  const debtBase = BigInt(Math.round((800 / health) * 1e8));
  const position = buildPosition([100_000_000_000n, debtBase, 0n, 8000n, 7500n, BigInt(Math.round(health * 1e6)) * 10n ** 12n], reserves(collateral, debt), USDC, 1.5);
  assert.ok(position);
  return position;
}

function market(chain: ChainKey, position: AavePosition | null, status: AaveMarket["status"] = "ok"): AaveMarket {
  return { status, chain, chainId: CHAINS[chain].chainId, pool: CHAINS[chain].pool, blockNumber: status === "unavailable" ? null : "54444913", blockTimestamp: null, position };
}

function perp(market: string, side: "long" | "short", distance: number | null, parts: Partial<PerpPosition> = {}): PerpPosition {
  return {
    market,
    dex: "",
    side,
    size: 1,
    entryPrice: 100,
    markPrice: 100,
    notionalUsd: 100,
    unrealizedPnlUsd: 0,
    margin: "cross",
    leverage: 3,
    marginUsedUsd: 33,
    liquidationPrice: distance === null ? null : 100 * (side === "long" ? 1 - distance : 1 + distance),
    distance,
    covered: true,
    coverageNote: "",
    ...parts,
  };
}

function account(positions: PerpPosition[], parts: Partial<HyperliquidAccount> = {}): HyperliquidAccount {
  return { ...NO_ACCOUNT, status: "ok", mode: "standard", readAt: 1794079360000, positions, ...parts };
}

function report(parts: Partial<{ base: AaveMarket; arbitrum: AaveMarket; hyperliquid: HyperliquidAccount }>): RiskReport {
  return assembleReport({
    address: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    target: 1.5,
    generatedAt: "2026-11-07T19:22:40.000Z",
    base: market("base", null),
    arbitrum: market("arbitrum", null),
    hyperliquid: account([]),
    failures: [],
    ...parts,
  });
}

const first = (entries: LineEntry[]) => entries[0] as LineEntry;

test("every position stands in one order, Aave and Hyperliquid together", () => {
  const result = buildLine(report({ base: market("base", borrower(1.5)), arbitrum: market("arbitrum", borrower(1.138)), hyperliquid: account([perp("AERO", "short", 0.2), perp("UNI", "short", 3.1)]) }));
  assert.deepEqual(
    result.entries.map((entry) => entry.id),
    ["aave.arbitrum", "perp..AERO", "aave.base", "perp..UNI"],
  );
  assert.equal(result.placed.length, 4);
  assert.deepEqual(
    pointsFor(result).map((point) => point.beyond),
    [false, false, false, true],
  );
});

test("a point carries its distance, its health factor or leverage, and whether Levee can repay it", () => {
  const [aave, short] = pointsFor(buildLine(report({ base: market("base", borrower(1.138)), hyperliquid: account([perp("AERO", "short", 0.448)]) })));
  assert.equal(aave?.percent, "12.1%");
  assert.equal(aave?.detail, "HF 1.138");
  assert.equal(aave?.repayable, true);
  assert.equal(short?.detail, "3x");
  assert.equal(short?.repayable, false);
});

test("the scale is a square root to 250%, and the trigger has a place on it", () => {
  assert.equal(scaleAt(0), 0);
  assert.equal(scaleAt(2.5), 1);
  assert.equal(scaleAt(6), 1);
  assert.ok(Math.abs(scaleAt(0.625) - 0.5) < 1e-12);
  assert.ok(Math.abs(triggerDistance(1.2) - 1 / 6) < 1e-12);
});

test("an isolated position reads not covered", () => {
  const result = buildLine(report({ hyperliquid: account([perp("SOL", "long", 0.4, { margin: "isolated", covered: false })]) }));
  const entry = first(result.entries);
  assert.equal(entry.reachLabel, "Not covered");
  assert.equal(pointsFor(result)[0]?.detail, "3x isolated");
  const [figures] = figuresFor(result, report({}));
  assert.equal(figures?.levee, "Not covered");
  assert.equal(figures?.meaning, "A fall in price");
  assert.match(figures?.backing as string, /own margin/);
});

test("debt with no USDC in it is named, and the repay is struck", () => {
  const position = borrower(1.058, [line("WETH", WETH, 756, false)], [line("wstETH", "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", 1000, false)]);
  const result = report({ base: market("base", position) });
  const built = buildLine(result);
  const entry = first(built.entries);
  assert.equal(entry.reach, "none");
  assert.equal(entry.reachLabel, "Cannot repay: WETH debt");
  assert.equal(pointsFor(built)[0]?.repayable, false);
  const [figures] = figuresFor(built, result);
  assert.equal(figures?.repayStruck, true);
  assert.equal(figures?.meaning, "One asset moving against the other");
});

test("USDC debt too small for the repay says how much Levee can do", () => {
  const position = borrower(1.1, [line("USDC", USDC, 100, true), line("WETH", WETH, 627, false)]);
  const entry = first(buildLine(report({ base: market("base", position) })).entries);
  assert.equal(entry.reach, "part");
  assert.match(entry.reachLabel, /^Up to \$100\.00, its USDC debt$/);
});

test("no reserve detail is not read as covered", () => {
  const position = buildPosition([100_000_000_000n, 60_000_000_000n, 0n, 8000n, 7500n, 1_333_000_000_000_000_000n], null, USDC, 1.5) as AavePosition;
  assert.equal(first(buildLine(report({ base: market("base", position) })).entries).reach, "unread");
});

test("collateral with no debt has no place on the line and says why", () => {
  const position = buildPosition([100_000_000_000n, 0n, 0n, 8000n, 7500n, 2n ** 256n - 1n], null, USDC, 1.5) as AavePosition;
  const result = buildLine(report({ base: market("base", position) }));
  assert.equal(result.placed.length, 0);
  assert.equal(unplacedLine(result), "Aave on Base has collateral and no debt.");
});

test("a position with no liquidation price is named", () => {
  assert.equal(unplacedLine(buildLine(report({ hyperliquid: account([perp("UNI", "short", null)]) }))), "Hyperliquid reports no liquidation price for UNI.");
});

test("a missing source is named, and nothing counts it as zero", () => {
  const result = buildLine(report({ base: market("base", null, "unavailable"), hyperliquid: NO_ACCOUNT }));
  assert.deepEqual(result.unread, ["Aave on Base", "Hyperliquid"]);
  assert.equal(unreadLine(result), "Not read: Aave on Base and Hyperliquid. Their positions are missing from this reading, and nothing counts them as zero.");
});

test("the last 5% starts inside 5%", () => {
  assert.equal(buildLine(report({ hyperliquid: account([perp("BTC", "long", 0.05)]) })).crisis, null);
  assert.ok(buildLine(report({ hyperliquid: account([perp("BTC", "long", 0.0499)]) })).crisis);
  assert.ok(buildLine(report({ base: market("base", borrower(0.97)) })).crisis);
});

test("in the last 5% everything else is two lines", () => {
  const result = buildLine(report({ base: market("base", borrower(1.012)), arbitrum: market("arbitrum", borrower(1.183)), hyperliquid: account([perp("AERO", "short", 0.42), perp("BTC", "short", 0.9)]) }));
  const crisis = crisisFor(result);
  assert.equal(crisis?.name, "Aave on Base");
  assert.equal(crisis?.percent, "1.1%");
  assert.deepEqual(crisis?.rest, ["Next: Aave on Arbitrum, 15.4%.", "Two more behind it."]);
  assert.match(crisis?.sentence as string, /^Aave on Base, health factor 1\.012\. At 1\.00 a liquidator can take collateral plus a 5% bonus\. This page only reads, and nothing is repaying it\.$/);
  assert.deepEqual(
    crisis?.figures.map((figure) => figure.label),
    ["Debt", "Collateral now", "Repay to reach 1.50"],
  );
});

test("the last 5% says when Levee cannot repay", () => {
  const position = borrower(1.03, [line("WETH", WETH, 776, false)]);
  const crisis = crisisFor(buildLine(report({ base: market("base", position) })));
  assert.equal(crisis?.hollow, true);
  assert.match(crisis?.sentence as string, /Levee cannot repay this debt, because it is WETH\.$/);
});

test("below 1.00 the last 5% says a liquidator can act now", () => {
  assert.match(crisisFor(buildLine(report({ base: market("base", borrower(0.97)) })))?.sentence as string, /below 1\.00, so a liquidator can act now/);
});

test("rest lines read well at any count", () => {
  assert.deepEqual(restLines([]), ["No other position at this address.", ""]);
  const result = buildLine(report({ hyperliquid: account([perp("BTC", "long", 0.3)]) }));
  assert.deepEqual(restLines(result.entries), ["Next: BTC, 30.0%.", "Nothing behind it."]);
});

test("a simulated fall uses the position's real terms and leaves the rest as read", () => {
  const read = report({ base: market("base", borrower(1.138)), arbitrum: market("arbitrum", borrower(1.183)), hyperliquid: account([perp("AERO", "short", 0.4)]) });
  const result = applyFall(read, 0.111);
  assert.ok(result);
  const built = buildLine(result.report);
  assert.equal(built.entries[0]?.id, "aave.base");
  assert.ok(Math.abs((result.report.aave.base.position?.healthFactor as number) - 1.138 * 0.889) < 1e-9);
  assert.equal(result.report.aave.arbitrum, read.aave.arbitrum);
  assert.equal(built.crisis?.id, "aave.base");
  assert.equal(result.whatIf.asset, "WETH");
  assert.equal(result.whatIf.blockNumber, "54444913");
  // Collateral falls, debt holds, and the repay follows from the same formula.
  const position = result.report.aave.base.position as AavePosition;
  assert.ok(Math.abs(position.collateralUsd - 889) < 1e-6);
  assert.ok((position.repay?.usd as number) > (read.aave.base.position?.repay?.usd as number));
});

test("an address with no Aave debt has nothing to mark down", () => {
  assert.equal(applyFall(report({ hyperliquid: account([perp("BTC", "long", 0.3)]) }), 0.1), null);
});

test("a fall from the address bar is checked", () => {
  assert.equal(parseFall("11.1"), 0.111);
  assert.equal(parseFall(null), null);
  assert.equal(parseFall(""), null);
  assert.equal(parseFall("0"), null);
  assert.equal(parseFall("-3"), null);
  assert.equal(parseFall("91"), null);
  assert.equal(parseFall("nope"), null);
});
