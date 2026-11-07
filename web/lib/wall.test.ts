import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPosition } from "./aave-model.ts";
import { CHAINS } from "./chains.ts";
import { NO_ACCOUNT } from "./hyperliquid-model.ts";
import { assembleReport } from "./report.ts";
import type { AaveMarket, AavePosition, ChainKey, HyperliquidAccount, PerpPosition, ReserveLine, Reserves, RiskReport } from "./types.ts";
import { buildWall, crisisFor, figuresFor, offAxisLine, restLines, rowFor, unreadLine, type WallEntry } from "./wall.ts";
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

const first = (entries: WallEntry[]) => entries[0] as WallEntry;

test("every position stands in one order, Aave and Hyperliquid together", () => {
  const wall = buildWall(report({ base: market("base", borrower(1.5)), arbitrum: market("arbitrum", borrower(1.138)), hyperliquid: account([perp("AERO", "short", 0.2), perp("UNI", "short", 1.45)]) }));
  assert.deepEqual(wall.entries.map((entry) => entry.id), ["aave.arbitrum", "perp..AERO", "aave.base", "perp..UNI"]);
  assert.equal(wall.onAxis.length, 3);
  assert.equal(wall.beyond.length, 1);
});

test("the axis takes a row's true distance, and the rule its size", () => {
  const row = rowFor(first(buildWall(report({ base: market("base", borrower(1.138)) })).entries), "home");
  assert.equal(row.percent, "12.1%");
  assert.equal(row.d, 12.13);
  assert.equal(row.tier, "large");
  assert.equal(row.line, "Health factor 1.138");
  assert.equal(row.line2, "WETH can fall this far");
  assert.equal(row.hollow, false);
});

test("the report view leads with the repay", () => {
  const row = rowFor(first(buildWall(report({ base: market("base", borrower(1.138)) })).entries), "report");
  assert.match(row.line, /^Repay \$\d+\.\d\d to reach 1\.50$/);
});

test("a short shows a rise and a long shows a fall", () => {
  const wall = buildWall(report({ hyperliquid: account([perp("AERO", "short", 0.4), perp("BTC", "long", 0.5)]) }));
  assert.equal(rowFor(wall.entries[0] as WallEntry, "home").line, "Hyperliquid, price rise");
  assert.equal(rowFor(wall.entries[1] as WallEntry, "home").line, "Hyperliquid, price fall");
});

test("an isolated position reads not covered and is drawn hollow", () => {
  const wall = buildWall(report({ hyperliquid: account([perp("SOL", "long", 0.4, { margin: "isolated", covered: false })]) }));
  const entry = first(wall.entries);
  assert.equal(entry.reachLabel, "Not covered");
  const row = rowFor(entry, "report");
  assert.equal(row.hollow, true);
  assert.equal(row.line, "Not covered, isolated margin");
  const [figures] = figuresFor(wall, report({}));
  assert.equal(figures?.levee, "Not covered");
  assert.match(figures?.backing as string, /own margin/);
});

test("debt with no USDC in it is named, and the repay is struck", () => {
  const position = borrower(1.058, [line("WETH", WETH, 756, false)], [line("wstETH", "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", 1000, false)]);
  const result = report({ base: market("base", position) });
  const wall = buildWall(result);
  const entry = first(wall.entries);
  assert.equal(entry.reach, "none");
  assert.equal(entry.reachLabel, "Cannot repay: WETH debt");
  const row = rowFor(entry, "home");
  assert.equal(row.hollow, true);
  assert.equal(row.line, "Levee cannot repay this");
  assert.equal(row.line2, "Against the debt, not a market fall");
  assert.equal(figuresFor(wall, result)[0]?.repayStruck, true);
});

test("USDC debt too small for the repay says how much Levee can do", () => {
  const position = borrower(1.1, [line("USDC", USDC, 100, true), line("WETH", WETH, 627, false)]);
  const entry = first(buildWall(report({ base: market("base", position) })).entries);
  assert.equal(entry.reach, "part");
  assert.match(rowFor(entry, "report").line, /^Levee can repay \$100\.00 of \$/);
});

test("no reserve detail is not read as covered", () => {
  const position = buildPosition([100_000_000_000n, 60_000_000_000n, 0n, 8000n, 7500n, 1_333_000_000_000_000_000n], null, USDC, 1.5) as AavePosition;
  assert.equal(first(buildWall(report({ base: market("base", position) })).entries).reach, "unread");
});

test("collateral with no debt sits off the axis and says why", () => {
  const position = buildPosition([100_000_000_000n, 0n, 0n, 8000n, 7500n, 2n ** 256n - 1n], null, USDC, 1.5) as AavePosition;
  const wall = buildWall(report({ base: market("base", position) }));
  assert.equal(wall.onAxis.length, 0);
  assert.equal(offAxisLine(wall, "home"), "Aave on Base has no debt.");
});

test("what is off the axis is named on the home view and pointed at on the report", () => {
  const wall = buildWall(report({ hyperliquid: account([perp("UNI", "short", 1.45), perp("HYPE", "short", 1.5), perp("ETH", "short", 1.75)]) }));
  assert.equal(offAxisLine(wall, "home"), "Three more are over 100% away, off this page: UNI, HYPE and ETH.");
  assert.equal(offAxisLine(wall, "report"), "Three more are over 100% away, listed below.");
});

test("a missing source is named and is not zero", () => {
  const wall = buildWall(report({ base: market("base", null, "unavailable"), hyperliquid: NO_ACCOUNT }));
  assert.deepEqual(wall.unread, ["Aave on Base", "Hyperliquid"]);
  assert.equal(unreadLine(wall), "Not read: Aave on Base and Hyperliquid. Their figures are missing, not zero.");
});

test("the crisis starts inside the last 5%, not at it", () => {
  assert.equal(buildWall(report({ hyperliquid: account([perp("BTC", "long", 0.05)]) })).crisis, null);
  assert.ok(buildWall(report({ hyperliquid: account([perp("BTC", "long", 0.0499)]) })).crisis);
  assert.ok(buildWall(report({ base: market("base", borrower(0.97)) })).crisis);
});

test("the crisis collapses everything else to two lines", () => {
  const wall = buildWall(report({ base: market("base", borrower(1.012)), arbitrum: market("arbitrum", borrower(1.183)), hyperliquid: account([perp("AERO", "short", 0.42), perp("BTC", "short", 0.9)]) }));
  const crisis = crisisFor(wall);
  assert.equal(crisis?.percent, "1.1%");
  assert.deepEqual(crisis?.rest, ["Next: Aave on Arbitrum, 15.4%", "Two more behind it"]);
  assert.match(crisis?.sentence as string, /^Aave on Base, health factor 1\.012\. At 1\.00 a liquidator can take collateral plus a 5% bonus\. This page only reads, and nothing is repaying it\.$/);
  assert.deepEqual(crisis?.figures.map((figure) => figure.label), ["Debt", "Collateral now", "Repay to reach 1.50"]);
});

test("the crisis says when Levee cannot repay", () => {
  const position = borrower(1.03, [line("WETH", WETH, 776, false)]);
  const crisis = crisisFor(buildWall(report({ base: market("base", position) })));
  assert.equal(crisis?.hollow, true);
  assert.match(crisis?.sentence as string, /Levee cannot repay this debt, because it is WETH\.$/);
});

test("below 1.00 the crisis says a liquidator can act now", () => {
  assert.match(crisisFor(buildWall(report({ base: market("base", borrower(0.97)) })))?.sentence as string, /below 1\.00, so a liquidator can act now/);
});

test("rest lines read well at any count", () => {
  assert.deepEqual(restLines([]), ["No other position at this address.", ""]);
  const wall = buildWall(report({ hyperliquid: account([perp("BTC", "long", 0.3)]) }));
  assert.deepEqual(restLines(wall.entries), ["Next: BTC, 30.0%", "Nothing behind it"]);
});

test("a simulated fall uses the position's real terms and leaves the rest as read", () => {
  const read = report({ base: market("base", borrower(1.138)), arbitrum: market("arbitrum", borrower(1.183)), hyperliquid: account([perp("AERO", "short", 0.4)]) });
  const result = applyFall(read, 0.111);
  assert.ok(result);
  const wall = buildWall(result.report);
  assert.equal(wall.entries[0]?.id, "aave.base");
  assert.ok(Math.abs((result.report.aave.base.position?.healthFactor as number) - 1.138 * 0.889) < 1e-9);
  assert.equal(result.report.aave.arbitrum, read.aave.arbitrum);
  assert.equal(wall.crisis?.id, "aave.base");
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
