/**
 * The JSON contract of GET /api/risk, and the data every page renders.
 * `schema` changes only when a field is removed or changes meaning.
 * Amounts are USD at Aave oracle prices or Hyperliquid marks. A null is missing data, not zero.
 */
export const SCHEMA = "levee.risk.v1";

/** ok: everything answered. partial: some figures are missing. unavailable: no figures at all. */
export type Status = "ok" | "partial" | "unavailable";

/** Reading bands set by Levee, by distance to liquidation. Only Aave and Hyperliquid liquidate. */
export type Stage = "dry" | "normal" | "watch" | "action" | "flood";

export type ChainKey = "base" | "arbitrum";
export type Venue = "aave.base" | "aave.arbitrum" | "hyperliquid";

export interface Failure {
  source: Venue;
  message: string;
}

export interface ReserveLine {
  asset: string;
  symbol: string;
  amount: number;
  usd: number;
  stable: boolean;
}

export interface Reserves {
  collateral: ReserveLine[];
  debt: ReserveLine[];
  eModeCategory: number;
}

/** Approximate fall in collateral value, relative to debt, that brings health factor to 1.00. */
export interface DropToLiquidation {
  approximate: true;
  /** 0.18 means about 18%. Zero at or below flood stage. */
  fraction: number;
  formula: "1 - 1/HF";
  assumption: string;
  /** True when collateral is volatile and debt is stable. Null when reserves were not read. */
  assumptionHolds: boolean | null;
  note: string | null;
}

export interface RepayFigure {
  target: number;
  /** R = D - (C * L) / T. Zero when the position is at or above target. */
  usd: number;
  /** Variable USDC debt, the only debt Levee repays. Null when reserves were not read. */
  usdcDebtUsd: number | null;
  /** False when USDC debt is smaller than the repay. Null when reserves were not read. */
  usdcCovers: boolean | null;
  /** Health factor after repaying all USDC debt. Null with no USDC debt or no reserve data. */
  healthAfterAllUsdc: number | null;
}

export interface AavePosition {
  stage: Stage;
  /** Null when there is no debt: the contract returns the maximum uint256. */
  healthFactor: number | null;
  collateralUsd: number;
  debtUsd: number;
  /** Weighted liquidation threshold, 0 to 1, e-mode included. */
  liquidationThreshold: number;
  ltv: number;
  dropToLiquidation: DropToLiquidation | null;
  repay: RepayFigure | null;
  reserves: Reserves | null;
  /** Exact getUserAccountData outputs as decimal strings, to compare with a direct call. */
  raw: {
    totalCollateralBase: string;
    totalDebtBase: string;
    availableBorrowsBase: string;
    currentLiquidationThreshold: string;
    ltv: string;
    healthFactor: string;
  };
}

export interface AaveMarket {
  status: Status;
  chain: ChainKey;
  chainId: number;
  pool: string;
  /** Every figure in this market was read at this block. */
  blockNumber: string | null;
  blockTimestamp: number | null;
  position: AavePosition | null;
}

export type HyperliquidMode = "standard" | "unified" | "portfolio" | "dex-abstraction" | "unknown";

/** Margin that backs cross positions together. */
export interface MarginPool {
  id: string;
  label: string;
  equityUsd: number;
  maintenanceUsd: number;
  /** Equity divided by maintenance margin. Liquidation is at 1.00. */
  marginRatio: number | null;
}

export interface PerpPosition {
  market: string;
  dex: string;
  side: "long" | "short";
  size: number;
  entryPrice: number;
  markPrice: number;
  notionalUsd: number;
  unrealizedPnlUsd: number;
  margin: "cross" | "isolated";
  leverage: number;
  marginUsedUsd: number;
  /** As reported by Hyperliquid. Null when it reports none. */
  liquidationPrice: number | null;
  /** Price move to liquidation as a fraction of mark. Null without a liquidation price. */
  distance: number | null;
  /** Whether a Levee top-up could reach this margin. Top-ups are a later phase and not live. */
  covered: boolean;
  coverageNote: string;
}

export interface HyperliquidAccount {
  status: Status;
  /** Hyperliquid server time of the read, in milliseconds. */
  readAt: number | null;
  mode: HyperliquidMode;
  /** The userAbstraction value as returned. Null when that read failed. */
  rawMode: string | null;
  /** Lowest ratio across pools. Null for portfolio accounts and accounts with no cross position. */
  marginRatio: number | null;
  stage: Stage;
  pools: MarginPool[];
  /** Nearest to liquidation first. */
  positions: PerpPosition[];
  notes: string[];
}

export interface Nearest {
  venue: Venue;
  label: string;
  stage: Stage;
  /** Same scale as dropToLiquidation.fraction and position distance. */
  fall: number;
}

export interface RiskReport {
  schema: typeof SCHEMA;
  address: string;
  generatedAt: string;
  status: Status;
  /** Health factor used for the repay figures. */
  target: number;
  failures: Failure[];
  aave: Record<ChainKey, AaveMarket>;
  hyperliquid: HyperliquidAccount;
  /** The reading closest to liquidation. Null when nothing can be liquidated or nothing was read. */
  nearest: Nearest | null;
}
