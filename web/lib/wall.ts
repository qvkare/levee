/**
 * The wall: every position at an address, at its distance from liquidation, nearest first. The
 * rows, the table and the crisis state all read this one model, so they cannot disagree. Pure.
 */
import { CHAINS } from "./chains.ts";
import { clock, countWord, dollars, integer, joined, percent, plainShare, ratio, usd } from "./format.ts";
import { LAST_STRETCH } from "./math.ts";
import { tierFor, type Tier } from "./punto.ts";
import type { AaveMarket, AavePosition, ChainKey, HyperliquidAccount, PerpPosition, ReserveLine, RiskReport, Venue } from "./types.ts";

/**
 * What Levee can do for a position. repays, part and none are Aave, by its USDC debt. unread is
 * Aave with no reserve detail. free has no debt. not-live is Hyperliquid margin a top-up would
 * reach, in a phase that is not running. uncovered is Hyperliquid margin it would not reach.
 */
export type Reach = "repays" | "part" | "none" | "unread" | "free" | "not-live" | "uncovered";

interface EntryBase {
  id: string;
  venue: Venue;
  name: string;
  /** Fraction to liquidation, at least zero. Null: there is none to report. */
  distance: number | null;
  reach: Reach;
  /** Reach, in words, for the Levee column. */
  reachLabel: string;
}

export interface AaveEntry extends EntryBase {
  kind: "aave";
  chain: ChainKey;
  market: AaveMarket;
  position: AavePosition;
}

export interface PerpEntry extends EntryBase {
  kind: "perp";
  perp: PerpPosition;
}

export type WallEntry = AaveEntry | PerpEntry;

/** home: what a stranger needs. report: what the owner of the address needs. */
export type WallView = "home" | "report";

/** One row on the wall, in the same words on the server and in the browser. */
export interface RowModel {
  id: string;
  name: string;
  /** Beside the number. The second shows only on a large row. */
  line: string;
  line2: string | null;
  /** Takes the place of both on a small row. */
  short: string;
  percent: string;
  /** Distance in percent, for the axis. Never quite zero, so the rule has something to divide by. */
  d: number;
  tier: Tier;
  /** Levee cannot reach it. The number is drawn in outline. */
  hollow: boolean;
}

export interface Wall {
  /** Everything at the address, nearest first. */
  entries: WallEntry[];
  /** On the axis: 100% or nearer. */
  onAxis: WallEntry[];
  /** Further than the axis goes. */
  beyond: WallEntry[];
  /** No distance to report. */
  unplaced: WallEntry[];
  /** Sources that gave no answer. Their figures are missing, not zero. */
  unread: string[];
  /** The nearest position, when it is inside the last 5%. */
  crisis: WallEntry | null;
}

const sum = (lines: ReserveLine[]) => lines.reduce((total, line) => total + line.usd, 0);

/** The one asset a position rests on, or null when no single asset does. */
export function collateralAsset(position: AavePosition): string | null {
  const lines = position.reserves?.collateral ?? [];
  const top = lines[0];
  if (!top) return null;
  return top.usd / sum(lines) >= 0.99 ? top.symbol : null;
}

/** Debt symbols, largest first: WETH, or USDC and WETH. */
export function debtAssets(position: AavePosition): string {
  return joined((position.reserves?.debt ?? []).map((line) => line.symbol));
}

function aaveReach(position: AavePosition): Pick<EntryBase, "reach" | "reachLabel"> {
  const repay = position.repay;
  if (position.healthFactor === null || !repay) return { reach: "free", reachLabel: "No debt to repay" };
  if (repay.usdcDebtUsd === null) return { reach: "unread", reachLabel: "Debt detail not read" };
  if (repay.usdcDebtUsd === 0) return { reach: "none", reachLabel: `Cannot repay: ${debtAssets(position)} debt` };
  if (repay.usdcCovers) return { reach: "repays", reachLabel: "Can repay" };
  return { reach: "part", reachLabel: `Up to ${usd(repay.usdcDebtUsd)}, its USDC debt` };
}

function aaveEntry(market: AaveMarket, position: AavePosition): AaveEntry {
  return {
    id: `aave.${market.chain}`,
    venue: `aave.${market.chain}`,
    kind: "aave",
    chain: market.chain,
    market,
    position,
    name: `Aave on ${CHAINS[market.chain].label}`,
    distance: position.dropToLiquidation?.fraction ?? null,
    ...aaveReach(position),
  };
}

function perpEntry(perp: PerpPosition, account: HyperliquidAccount): PerpEntry {
  const shared = perp.margin === "cross" && account.marginRatio !== null && account.marginRatio < 1;
  return {
    id: `perp.${perp.dex}.${perp.market}`,
    venue: "hyperliquid",
    kind: "perp",
    perp,
    name: `${perp.market} ${perp.side}`,
    distance: perp.distance === null ? null : shared ? 0 : Math.max(0, perp.distance),
    reach: perp.covered ? "not-live" : "uncovered",
    reachLabel: perp.covered ? "Top-ups not live" : "Not covered",
  };
}

function order(a: WallEntry, b: WallEntry): number {
  return (a.distance ?? Infinity) - (b.distance ?? Infinity);
}

export function buildWall(report: RiskReport): Wall {
  const markets = [report.aave.base, report.aave.arbitrum];
  const entries = [
    ...markets.flatMap((market) => (market.position ? [aaveEntry(market, market.position)] : [])),
    ...report.hyperliquid.positions.map((perp) => perpEntry(perp, report.hyperliquid)),
  ].sort(order);

  const unread = markets.filter((market) => market.status === "unavailable").map((market) => `Aave on ${CHAINS[market.chain].label}`);
  if (report.hyperliquid.status === "unavailable") unread.push("Hyperliquid");

  const first = entries[0];
  return {
    entries,
    onAxis: entries.filter((entry) => entry.distance !== null && entry.distance <= 1),
    beyond: entries.filter((entry) => entry.distance !== null && entry.distance > 1),
    unplaced: entries.filter((entry) => entry.distance === null),
    unread,
    crisis: first && first.distance !== null && first.distance < LAST_STRETCH ? first : null,
  };
}

/** How to read the number. It is a market fall only when the collateral is volatile and the debt is not. */
function moveLine(position: AavePosition): string {
  const asset = collateralAsset(position) ?? "Collateral";
  const reserves = position.reserves;
  const drop = position.dropToLiquidation;
  if (!reserves || !drop) return `${asset} against the debt`;
  if (drop.assumptionHolds !== false) return `${asset} can fall this far`;
  if (reserves.debt.some((line) => !line.stable)) return "Against the debt, not a market fall";
  return reserves.collateral.every((line) => line.stable) ? "The size of a depeg, not a market fall" : "The market fall needed is larger";
}

function repayLine(position: AavePosition, reach: Reach): string {
  const repay = position.repay;
  if (!repay) return "No debt";
  if (reach === "none") return "Levee cannot repay this";
  const target = repay.target.toFixed(2);
  if (repay.usd === 0) return `Above ${target}, no repay needed`;
  if (reach === "part") return `Levee can repay ${usd(repay.usdcDebtUsd ?? 0)} of ${usd(repay.usd)}`;
  return `Repay ${usd(repay.usd)} to reach ${target}`;
}

function aaveLines(entry: AaveEntry, view: WallView): Pick<RowModel, "line" | "line2" | "short"> {
  const { position, reach } = entry;
  const health = `Health factor ${ratio(position.healthFactor ?? 0)}`;
  const first = view === "report" || reach === "none" ? repayLine(position, reach) : health;
  return { line: first, line2: moveLine(position), short: reach === "none" ? "Levee cannot repay this" : health };
}

function perpLines(entry: PerpEntry, view: WallView): Pick<RowModel, "line" | "line2" | "short"> {
  const { perp, reach } = entry;
  const direction = perp.side === "long" ? "price fall" : "price rise";
  const uncovered = reach === "uncovered";
  const line = uncovered ? `Not covered, ${perp.margin === "isolated" ? "isolated margin" : "Hyperliquid"}` : view === "report" && perp.liquidationPrice !== null ? `Liquidation price ${dollars(perp.liquidationPrice)}` : `Hyperliquid, ${direction}`;
  return { line, line2: uncovered || view === "report" ? `Hyperliquid, ${direction}` : null, short: uncovered ? "Not covered" : "Hyperliquid" };
}

export function rowFor(entry: WallEntry, view: WallView): RowModel {
  const distance = entry.distance ?? 0;
  const d = Math.max(0.01, Math.round(distance * 10_000) / 100);
  return {
    id: entry.id,
    name: entry.name,
    ...(entry.kind === "aave" ? aaveLines(entry, view) : perpLines(entry, view)),
    percent: percent(distance),
    d,
    tier: tierFor(d),
    hollow: entry.reach === "none" || entry.reach === "uncovered",
  };
}

/** A short name, for a sentence that lists positions. */
function shortName(entry: WallEntry): string {
  return entry.kind === "perp" ? entry.perp.market : entry.name;
}

const moreLine = (count: number) => `${countWord(count)} more ${count === 1 ? "is" : "are"} over 100% away`;

/** What is not on the axis, in one sentence, or null when everything is. */
export function offAxisLine(wall: Wall, view: WallView): string | null {
  const parts: string[] = [];
  if (wall.beyond.length) parts.push(view === "report" ? `${moreLine(wall.beyond.length)}, listed below.` : `${moreLine(wall.beyond.length)}, off this page: ${joined(wall.beyond.map(shortName))}.`);
  const reported = wall.unplaced.filter((entry) => entry.kind === "perp");
  if (reported.length) parts.push(`Hyperliquid reports no liquidation price for ${joined(reported.map(shortName))}.`);
  const free = wall.unplaced.filter((entry) => entry.kind === "aave");
  if (free.length) parts.push(`${joined(free.map(shortName))} ${free.length === 1 ? "has" : "have"} no debt.`);
  return parts.length ? parts.join(" ") : null;
}

/** Sources that did not answer, or null when all did. Missing is not zero. */
export function unreadLine(wall: Wall): string | null {
  if (wall.unread.length === 0) return null;
  return `Not read: ${joined(wall.unread)}. ${wall.unread.length === 1 ? "Its figures are" : "Their figures are"} missing, not zero.`;
}

/** Everyone but the nearest, in two lines. */
export function restLines(entries: WallEntry[]): [string, string] {
  const [next, ...others] = entries;
  if (!next) return ["No other position at this address.", ""];
  const place = next.distance === null ? "no distance reported" : percent(next.distance);
  const tail = others.length === 0 ? "Nothing behind it" : `${countWord(others.length)} more behind it`;
  return [`Next: ${shortName(next)}, ${place}`, tail];
}

export interface Figures {
  id: string;
  position: string;
  distance: string;
  health: string;
  /** Margin mode and the like: the first thing to go at narrow widths. */
  healthNote: string;
  size: string;
  backing: string;
  backingQuiet: boolean;
  liquidatesAt: string;
  liquidatesNote: string;
  repay: string;
  /** The figure stands, and Levee cannot make that repay. */
  repayStruck: boolean;
  repayQuiet: boolean;
  levee: string;
  readAt: string;
}

function aaveFigures(entry: AaveEntry): Figures {
  const { position, market, reach } = entry;
  const asset = collateralAsset(position);
  const repay = position.repay;
  return {
    id: entry.id,
    position: entry.name,
    distance: entry.distance === null ? "No debt" : percent(entry.distance),
    health: position.healthFactor === null ? "No debt" : ratio(position.healthFactor),
    healthNote: "",
    size: position.debtUsd > 0 ? `${usd(position.debtUsd)} debt` : "No debt",
    backing: `${usd(position.collateralUsd)} ${asset ?? "collateral"}`,
    backingQuiet: false,
    liquidatesAt: "HF 1.00",
    liquidatesNote: `, ${plainShare(position.liquidationThreshold)} threshold`,
    repay: !repay ? "none" : repay.usd === 0 ? "none needed" : usd(repay.usd),
    repayStruck: reach === "none" && (repay?.usd ?? 0) > 0,
    repayQuiet: !repay || repay.usd === 0,
    levee: entry.reachLabel,
    readAt: market.blockNumber === null ? "not read" : `block ${integer(market.blockNumber)}`,
  };
}

function perpFigures(entry: PerpEntry, readAt: number | null): Figures {
  const { perp } = entry;
  return {
    id: entry.id,
    position: perp.market,
    distance: entry.distance === null ? "None reported" : percent(entry.distance),
    health: `${perp.side === "long" ? "Long" : "Short"}, ${perp.leverage}x`,
    healthNote: ` ${perp.margin}`,
    size: usd(perp.notionalUsd),
    backing: perp.margin === "cross" ? "shared margin" : `${usd(perp.marginUsedUsd)} own margin`,
    backingQuiet: perp.margin === "cross",
    liquidatesAt: perp.liquidationPrice === null ? "none reported" : dollars(perp.liquidationPrice),
    liquidatesNote: "",
    repay: "not applicable",
    repayStruck: false,
    repayQuiet: true,
    levee: entry.reachLabel,
    readAt: readAt === null ? "not read" : clock(readAt),
  };
}

export function figuresFor(wall: Wall, report: RiskReport): Figures[] {
  return wall.entries.map((entry) => (entry.kind === "aave" ? aaveFigures(entry) : perpFigures(entry, report.hyperliquid.readAt)));
}

export interface CrisisModel {
  percent: string;
  hollow: boolean;
  rest: [string, string];
  /** What this is, and what is doing nothing about it. */
  sentence: string;
  figures: Array<{ label: string; value: string }>;
}

function aaveCrisis(entry: AaveEntry): Pick<CrisisModel, "sentence" | "figures"> {
  const { position, name, reach } = entry;
  const health = position.healthFactor ?? 0;
  const bonus = position.reserves?.liquidationBonus;
  const prize = bonus ? `a ${plainShare(bonus)} bonus` : "a bonus";
  const liquidator = health < 1 ? `It is below 1.00, so a liquidator can act now and take collateral plus ${prize}.` : `At 1.00 a liquidator can take collateral plus ${prize}.`;
  const tail = reach === "none" ? `Levee cannot repay this debt, because it is ${debtAssets(position)}.` : "This page only reads, and nothing is repaying it.";
  const target = position.repay?.target ?? 1.5;
  return {
    sentence: `${name}, health factor ${ratio(health)}. ${liquidator} ${tail}`,
    figures: [
      { label: "Debt", value: usd(position.debtUsd) },
      { label: "Collateral now", value: usd(position.collateralUsd) },
      { label: `Repay to reach ${target.toFixed(2)}`, value: usd(position.repay?.usd ?? 0) },
    ],
  };
}

function perpCrisis(entry: PerpEntry): Pick<CrisisModel, "sentence" | "figures"> {
  const { perp, name } = entry;
  const where = perp.liquidationPrice === null ? "its liquidation price" : `its liquidation price of ${dollars(perp.liquidationPrice)}`;
  return {
    sentence: `${name} on Hyperliquid, ${percent(entry.distance ?? 0)} from ${where}. This page only reads, and nothing is topping it up.`,
    figures: [
      { label: "Size", value: usd(perp.notionalUsd) },
      { label: "Mark price", value: dollars(perp.markPrice) },
      { label: "Liquidates at", value: perp.liquidationPrice === null ? "none reported" : dollars(perp.liquidationPrice) },
    ],
  };
}

export function crisisFor(wall: Wall): CrisisModel | null {
  const entry = wall.crisis;
  if (!entry) return null;
  const others = wall.entries.filter((other) => other !== entry);
  return {
    percent: percent(entry.distance ?? 0),
    hollow: entry.reach === "none" || entry.reach === "uncovered",
    rest: restLines(others),
    ...(entry.kind === "aave" ? aaveCrisis(entry) : perpCrisis(entry)),
  };
}

/** The source and moment of a reading, for the line above the crisis number. */
export function readingLine(entry: WallEntry, report: RiskReport): string {
  if (entry.kind === "aave") return `${entry.name}, at block ${integer(entry.market.blockNumber ?? 0)}.`;
  return `Hyperliquid, at ${report.hyperliquid.readAt === null ? "an unknown time" : clock(report.hyperliquid.readAt)}.`;
}

/** The position Levee could act on first, if any: the first row with a repay it can make. */
export function firstAave(wall: Wall): AaveEntry | null {
  return wall.entries.find((entry): entry is AaveEntry => entry.kind === "aave" && entry.distance !== null) ?? null;
}
