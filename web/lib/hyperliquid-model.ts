/**
 * Turns Hyperliquid info responses into the reported account. No network here.
 *
 * The account mode decides where equity lives. In unified mode the docs warn that per-DEX state is
 * not meaningful, and crossMarginSummary understated equity by up to 63% in our measurements. There,
 * equity is the spot total less isolated margin, per collateral token, as in Hyperliquid's
 * computeUnifiedAccountRatio. This reproduced liquidationPx at 0.00% on live accounts.
 */
import { stageForFall } from "./math.ts";
import type { HyperliquidAccount, HyperliquidMode, MarginPool, PerpPosition, Stage } from "./types.ts";

export interface RawPosition {
  coin: string;
  szi: string;
  entryPx: string | null;
  positionValue: string;
  unrealizedPnl: string;
  liquidationPx: string | null;
  marginUsed: string;
  leverage: { type: "cross" | "isolated"; value: number; rawUsd?: string };
}

export interface RawClearinghouse {
  crossMarginSummary: { accountValue: string };
  crossMaintenanceMarginUsed: string;
  assetPositions: Array<{ position: RawPosition }>;
  time: number;
}

export interface RawSpot {
  balances: Array<{ coin: string; token: number; total: string }>;
}

export interface DexState {
  dex: string;
  collateralToken: number;
  state: RawClearinghouse;
}

export interface HyperliquidInput {
  abstraction: string | null;
  spot: RawSpot | null;
  dexes: DexState[];
}

const USDC_TOKEN = 0;

/** What a failed read reports. The stage says nothing, so the page must check the status first. */
export const NO_ACCOUNT: HyperliquidAccount = {
  status: "unavailable",
  readAt: null,
  mode: "unknown",
  rawMode: null,
  marginRatio: null,
  stage: "dry",
  pools: [],
  positions: [],
  notes: [],
};

export function modeOf(raw: string | null): HyperliquidMode {
  switch (raw) {
    case "default":
    case "disabled":
      return "standard";
    case "unifiedAccount":
      return "unified";
    case "portfolioMargin":
      return "portfolio";
    case "dexAbstraction":
      return "dex-abstraction";
    default:
      return "unknown";
  }
}

export function coverage(mode: HyperliquidMode, margin: "cross" | "isolated", dex: string, collateralToken: number): Pick<PerpPosition, "covered" | "coverageNote"> {
  if (margin === "isolated") {
    return { covered: false, coverageNote: "Isolated margin uses only its own balance. A credit to the account does not reach it." };
  }
  if (mode === "portfolio") return { covered: false, coverageNote: "Portfolio margin liquidates as one account. Levee does not model it." };
  if (mode === "unknown") return { covered: false, coverageNote: "The account mode was not read." };
  if (mode === "unified") {
    return collateralToken === USDC_TOKEN
      ? { covered: true, coverageNote: "Cross margin on a USDC balance. A USDC top-up would reach it." }
      : { covered: false, coverageNote: "This DEX settles in another token. A USDC credit does not reach it." };
  }
  return dex === ""
    ? { covered: true, coverageNote: "Cross margin on the main DEX. A USDC top-up would reach it." }
    : { covered: false, coverageNote: "In standard mode each DEX has its own cross margin. A credit lands on the main DEX." };
}

function toPosition(raw: RawPosition, dex: string, collateralToken: number, mode: HyperliquidMode): PerpPosition | null {
  const signed = Number(raw.szi);
  if (!signed) return null;
  const size = Math.abs(signed);
  const notionalUsd = Number(raw.positionValue);
  const markPrice = notionalUsd / size;
  const liquidationPrice = raw.liquidationPx === null ? null : Number(raw.liquidationPx);
  const side = signed > 0 ? "long" : "short";
  const distance = liquidationPrice === null ? null : (side === "long" ? markPrice - liquidationPrice : liquidationPrice - markPrice) / markPrice;
  return {
    market: raw.coin,
    dex,
    side,
    size,
    entryPrice: Number(raw.entryPx),
    markPrice,
    notionalUsd,
    unrealizedPnlUsd: Number(raw.unrealizedPnl),
    margin: raw.leverage.type,
    leverage: raw.leverage.value,
    marginUsedUsd: Number(raw.marginUsed),
    liquidationPrice,
    distance,
    ...coverage(mode, raw.leverage.type, dex, collateralToken),
  };
}

const ratio = (equityUsd: number, maintenanceUsd: number) => (maintenanceUsd > 0 ? equityUsd / maintenanceUsd : null);

/** Each DEX with a cross position is its own pool, using its own cross summary. */
function standardPools(dexes: DexState[]): MarginPool[] {
  return dexes
    .filter(({ state }) => state.assetPositions.some(({ position }) => position.leverage.type === "cross"))
    .map(({ dex, state }) => {
      const equityUsd = Number(state.crossMarginSummary.accountValue);
      const maintenanceUsd = Number(state.crossMaintenanceMarginUsed);
      return { id: `dex:${dex}`, label: dex ? `${dex} DEX` : "Main DEX", equityUsd, maintenanceUsd, marginRatio: ratio(equityUsd, maintenanceUsd) };
    });
}

/** One balance per collateral token backs every DEX that uses it. */
function unifiedPools(dexes: DexState[], spot: RawSpot): MarginPool[] {
  const tokens = new Set(
    dexes
      .filter(({ state }) => state.assetPositions.some(({ position }) => position.leverage.type === "cross"))
      .map(({ collateralToken }) => collateralToken),
  );
  return [...tokens].map((token) => {
    const members = dexes.filter(({ collateralToken }) => collateralToken === token);
    const balance = spot.balances.find((entry) => entry.token === token);
    const isolatedUsd = members
      .flatMap(({ state }) => state.assetPositions)
      .filter(({ position }) => position.leverage.type === "isolated")
      .reduce((total, { position }) => total + Number(position.marginUsed), 0);
    const equityUsd = Number(balance?.total ?? 0) - isolatedUsd;
    const maintenanceUsd = members.reduce((total, { state }) => total + Number(state.crossMaintenanceMarginUsed), 0);
    return { id: `token:${token}`, label: `${balance?.coin ?? `Token ${token}`} balance`, equityUsd, maintenanceUsd, marginRatio: ratio(equityUsd, maintenanceUsd) };
  });
}

const NOTES: Partial<Record<HyperliquidMode, string>> = {
  unified: "Unified account. Equity comes from the spot balance, because per-DEX state is not meaningful in this mode.",
  portfolio: "Portfolio margin account. Its liquidation ratio needs borrow caps and oracle prices, so no ratio is shown. Liquidation prices are as reported by Hyperliquid.",
  "dex-abstraction": "DEX abstraction is a discontinued mode. The ratio is worked out per DEX as in standard mode and may be off on HIP-3 markets.",
  unknown: "The account mode was not read, so no margin ratio is shown.",
};

function accountStage(positions: PerpPosition[], marginRatio: number | null): Stage {
  if (positions.length === 0) return "dry";
  if (marginRatio !== null && marginRatio < 1) return "flood";
  const nearest = positions[0]?.distance ?? null;
  return nearest === null ? "normal" : stageForFall(nearest);
}

export function buildAccount({ abstraction, spot, dexes }: HyperliquidInput): HyperliquidAccount {
  const mode = modeOf(abstraction);
  const positions = dexes
    .flatMap(({ dex, collateralToken, state }) => state.assetPositions.map(({ position }) => toPosition(position, dex, collateralToken, mode)))
    .filter((position) => position !== null)
    .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));

  let pools: MarginPool[] = [];
  const notes: string[] = [];
  if (mode === "standard" || mode === "dex-abstraction") pools = standardPools(dexes);
  if (mode === "unified" && spot) pools = unifiedPools(dexes, spot);
  if (mode === "unified" && !spot) notes.push("The spot balance was not read, so no margin ratio is shown.");
  const note = NOTES[mode];
  if (note) notes.unshift(note);

  const ratios = pools.map((pool) => pool.marginRatio).filter((value) => value !== null);
  const marginRatio = ratios.length ? Math.min(...ratios) : null;
  return {
    status: "ok",
    readAt: Math.max(0, ...dexes.map(({ state }) => state.time)) || null,
    mode,
    rawMode: abstraction,
    marginRatio,
    stage: accountStage(positions, marginRatio),
    pools,
    positions,
    notes,
  };
}
