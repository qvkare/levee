import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildAccount, coverage, modeOf, type DexState, type HyperliquidInput, type RawClearinghouse, type RawPosition, type RawSpot } from "./hyperliquid-model.ts";

interface Fixture extends HyperliquidInput {
  spot: RawSpot & { tokenToAvailableAfterMaintenance?: Array<[number, string]> };
}

const fixture = (name: string): Fixture => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

/** Hyperliquid's documented formula, solved for the price, using this model's equity. */
function liquidationPrice(markPrice: number, signedSize: number, equity: number, maintenance: number, notional: number): number {
  const side = signedSize > 0 ? 1 : -1;
  const fraction = maintenance / notional;
  return markPrice - (side * (equity - maintenance)) / Math.abs(signedSize) / (1 - fraction * side);
}

const close = (a: number, b: number, tolerance: number) => Math.abs(a - b) / Math.abs(b) <= tolerance;

test("unified account: equity reproduces Hyperliquid's own liquidation price and available balance", () => {
  const input = fixture("hl-unified");
  const account = buildAccount(input);
  assert.equal(account.mode, "unified");
  const pool = account.pools[0];
  assert.ok(pool);

  const position = input.dexes.flatMap(({ state }) => state.assetPositions).map(({ position: raw }) => raw).find((raw) => raw.leverage.type === "cross") as RawPosition;
  const signedSize = Number(position.szi);
  const notional = Number(position.positionValue);
  const predicted = liquidationPrice(notional / Math.abs(signedSize), signedSize, pool.equityUsd, pool.maintenanceUsd, notional);
  assert.ok(close(predicted, Number(position.liquidationPx), 0.001), `${predicted} against ${position.liquidationPx}`);

  const available = input.spot.tokenToAvailableAfterMaintenance?.find(([token]) => token === 0)?.[1];
  assert.ok(available);
  assert.ok(close(pool.equityUsd - pool.maintenanceUsd, Number(available), 0.0001));
});

test("unified account: the per-DEX summary would be wrong, which is why the model does not use it", () => {
  const input = fixture("hl-unified");
  const main = input.dexes[0]?.state as RawClearinghouse;
  const pool = buildAccount(input).pools[0];
  assert.notEqual(Number(main.crossMarginSummary.accountValue), pool?.equityUsd);
});

test("standard account: equity is the cross summary, and it reproduces the liquidation price", () => {
  const input = fixture("hl-standard");
  const account = buildAccount(input);
  assert.equal(account.mode, "standard");
  const pool = account.pools[0];
  assert.ok(pool);
  const main = input.dexes[0]?.state as RawClearinghouse;
  assert.equal(pool.equityUsd, Number(main.crossMarginSummary.accountValue));

  const position = main.assetPositions.map(({ position: raw }) => raw).find((raw) => raw.leverage.type === "cross") as RawPosition;
  const signedSize = Number(position.szi);
  const notional = Number(position.positionValue);
  const predicted = liquidationPrice(notional / Math.abs(signedSize), signedSize, pool.equityUsd, pool.maintenanceUsd, notional);
  assert.ok(close(predicted, Number(position.liquidationPx), 0.001), `${predicted} against ${position.liquidationPx}`);
});

const raw = (overrides: Partial<RawPosition>): { position: RawPosition } => ({
  position: {
    coin: "BTC",
    szi: "1",
    entryPx: "100",
    positionValue: "100",
    unrealizedPnl: "0",
    liquidationPx: "80",
    marginUsed: "10",
    leverage: { type: "cross", value: 10 },
    ...overrides,
  },
});

const dex = (positions: Array<{ position: RawPosition }>, extra: Partial<DexState> = {}, accountValue = "50", maintenance = "5"): DexState => ({
  dex: "",
  collateralToken: 0,
  state: { crossMarginSummary: { accountValue }, crossMaintenanceMarginUsed: maintenance, assetPositions: positions, time: 1000 },
  ...extra,
});

test("account modes", () => {
  assert.equal(modeOf("default"), "standard");
  assert.equal(modeOf("disabled"), "standard");
  assert.equal(modeOf("unifiedAccount"), "unified");
  assert.equal(modeOf("portfolioMargin"), "portfolio");
  assert.equal(modeOf("dexAbstraction"), "dex-abstraction");
  assert.equal(modeOf("somethingNew"), "unknown");
  assert.equal(modeOf(null), "unknown");
});

test("distance is measured toward liquidation on both sides", () => {
  const account = buildAccount({
    abstraction: "default",
    spot: null,
    dexes: [dex([raw({ coin: "LONG" }), raw({ coin: "SHORT", szi: "-1", liquidationPx: "130" })])],
  });
  const byMarket = Object.fromEntries(account.positions.map((position) => [position.market, position]));
  assert.ok(Math.abs((byMarket.LONG?.distance as number) - 0.2) < 1e-9);
  assert.ok(Math.abs((byMarket.SHORT?.distance as number) - 0.3) < 1e-9);
  assert.equal(account.positions[0]?.market, "LONG"); // nearest first
  assert.equal(account.marginRatio, 10); // 50 / 5
  assert.equal(account.stage, "watch");
});

test("isolated positions are labelled not covered in every mode", () => {
  for (const mode of ["standard", "unified", "dex-abstraction"] as const) {
    assert.equal(coverage(mode, "isolated", "", 0).covered, false);
  }
  const account = buildAccount({ abstraction: "default", spot: null, dexes: [dex([raw({ leverage: { type: "isolated", value: 5 } })])] });
  assert.equal(account.positions[0]?.covered, false);
  assert.match(account.positions[0]?.coverageNote as string, /Isolated/);
  assert.deepEqual(account.pools, []); // No cross position, so no cross pool.
  assert.equal(account.marginRatio, null);
});

test("coverage follows where a USDC credit can land", () => {
  assert.equal(coverage("standard", "cross", "", 0).covered, true);
  assert.equal(coverage("standard", "cross", "xyz", 0).covered, false);
  assert.equal(coverage("unified", "cross", "xyz", 0).covered, true);
  assert.equal(coverage("unified", "cross", "flx", 360).covered, false);
  assert.equal(coverage("portfolio", "cross", "", 0).covered, false);
  assert.equal(coverage("unknown", "cross", "", 0).covered, false);
});

test("portfolio accounts show positions but no invented ratio", () => {
  const account = buildAccount({ abstraction: "portfolioMargin", spot: { balances: [] }, dexes: [dex([raw({})])] });
  assert.equal(account.marginRatio, null);
  assert.deepEqual(account.pools, []);
  assert.equal(account.positions.length, 1);
  assert.match(account.notes[0] as string, /Portfolio margin/);
});

test("a unified account without its spot balance gets no ratio, not a wrong one", () => {
  const account = buildAccount({ abstraction: "unifiedAccount", spot: null, dexes: [dex([raw({})])] });
  assert.equal(account.marginRatio, null);
  assert.ok(account.notes.some((note) => /spot balance/.test(note)));
});

test("unified pools are per collateral token and subtract isolated margin", () => {
  const account = buildAccount({
    abstraction: "unifiedAccount",
    spot: { balances: [{ coin: "USDC", token: 0, total: "100" }] },
    dexes: [dex([raw({}), raw({ coin: "ETH", marginUsed: "20", leverage: { type: "isolated", value: 5 } })]), dex([raw({ coin: "xyz:GOLD" })], { dex: "xyz" }, "0", "5")],
  });
  assert.equal(account.pools.length, 1);
  assert.equal(account.pools[0]?.equityUsd, 80);
  assert.equal(account.pools[0]?.maintenanceUsd, 10);
  assert.equal(account.marginRatio, 8);
});

test("the lowest pool ratio is the account ratio, and below 1.00 is flood stage", () => {
  const account = buildAccount({
    abstraction: "default",
    spot: null,
    dexes: [dex([raw({})], {}, "50", "5"), dex([raw({ coin: "xyz:GOLD" })], { dex: "xyz" }, "4", "5")],
  });
  assert.equal(account.marginRatio, 0.8);
  assert.equal(account.stage, "flood");
});

test("a null liquidation price stays null and sorts last", () => {
  const account = buildAccount({ abstraction: "default", spot: null, dexes: [dex([raw({ coin: "NONE", liquidationPx: null }), raw({ coin: "NEAR" })])] });
  assert.equal(account.positions[0]?.market, "NEAR");
  assert.equal(account.positions[1]?.distance, null);
});

test("an empty account is dry", () => {
  const account = buildAccount({ abstraction: "default", spot: null, dexes: [dex([])] });
  assert.equal(account.stage, "dry");
  assert.equal(account.marginRatio, null);
});
