/**
 * The distance line: every position at an address, placed by how far it is from liquidation,
 * nearest first. The drawing, the figures table and the last-5% state all read this one model, so
 * they cannot disagree. Pure.
 */
import { CHAINS } from "./chains.ts";
import { clock, countWord, dollars, integer, joined, percent, plainShare, ratio, usd } from "./format.ts";
import { LAST_STRETCH, approxFall } from "./math.ts";
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

export type LineEntry = AaveEntry | PerpEntry;

export interface DistanceLine {
  /** Everything at the address, nearest first. */
  entries: LineEntry[];
  /** With a distance to place. */
  placed: LineEntry[];
  /** No distance to report. */
  unplaced: LineEntry[];
  /** Sources that gave no answer. Their figures are missing, and nothing counts them as zero. */
  unread: string[];
  /** The nearest position, when it is inside the last 5%. */
  crisis: LineEntry | null;
}

/** The line runs on a square-root scale to 250%. Anything further sits past its end, marked off scale. */
export const SCALE_MAX = 2.5;
export const SCALE_TICKS = [0.1, 0.25, 0.5, 1, 1.5, 2, 2.5];

/** Where a distance sits along the line, from 0 at liquidation to 1 at the end of the scale. */
export function scaleAt(distance: number): number {
  return Math.sqrt(Math.min(Math.max(distance, 0), SCALE_MAX) / SCALE_MAX);
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

function order(a: LineEntry, b: LineEntry): number {
  return (a.distance ?? Infinity) - (b.distance ?? Infinity);
}

export function buildLine(report: RiskReport): DistanceLine {
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
    placed: entries.filter((entry) => entry.distance !== null),
    unplaced: entries.filter((entry) => entry.distance === null),
    unread,
    crisis: first && first.distance !== null && first.distance < LAST_STRETCH ? first : null,
  };
}

/** Levee can act on it now: Aave with USDC debt. Drawn in the position's blue. */
export const repayable = (entry: LineEntry) => entry.reach === "repays" || entry.reach === "part";

/** One point on the line, in the same words on the server and in the browser. */
export interface LinePoint {
  id: string;
  name: string;
  /** Fraction to liquidation. */
  distance: number;
  percent: string;
  /** Health factor, or leverage and margin. */
  detail: string;
  repayable: boolean;
  /** Past the end of the scale. */
  beyond: boolean;
}

function detailOf(entry: LineEntry): string {
  if (entry.kind === "aave") return `HF ${ratio(entry.position.healthFactor ?? 0)}`;
  return entry.perp.margin === "isolated" ? `${entry.perp.leverage}x isolated` : `${entry.perp.leverage}x`;
}

export function pointsFor(line: DistanceLine): LinePoint[] {
  return line.placed.map((entry) => {
    const distance = entry.distance ?? 0;
    return { id: entry.id, name: entry.name, distance, percent: percent(distance), detail: detailOf(entry), repayable: repayable(entry), beyond: distance > SCALE_MAX };
  });
}

/** The distance a trigger stands at, for volatile collateral against stable debt. */
export const triggerDistance = (trigger: number) => approxFall(trigger);

/** What a distance means for this position, in a few words. */
export function meaningOf(entry: LineEntry): string {
  if (entry.kind === "perp") return entry.perp.side === "long" ? "A fall in price" : "A rise in price";
  const { position } = entry;
  const reserves = position.reserves;
  const drop = position.dropToLiquidation;
  const asset = collateralAsset(position) ?? "collateral";
  if (!reserves || !drop || drop.assumptionHolds !== false) return `A fall in ${asset} against the debt`;
  if (reserves.debt.some((line) => !line.stable)) return "One asset moving against the other";
  return reserves.collateral.every((line) => line.stable) ? "The size of a depeg" : "Needs a larger market fall";
}

/** Short names, for a sentence that lists positions. */
function shortName(entry: LineEntry): string {
  return entry.kind === "perp" ? entry.perp.market : entry.name;
}

/** What has no place on the line, in one sentence, or null when everything has one. */
export function unplacedLine(line: DistanceLine): string | null {
  const parts: string[] = [];
  const reported = line.unplaced.filter((entry) => entry.kind === "perp");
  if (reported.length) parts.push(`Hyperliquid reports no liquidation price for ${joined(reported.map(shortName))}.`);
  const free = line.unplaced.filter((entry) => entry.kind === "aave");
  if (free.length) parts.push(`${joined(free.map(shortName))} ${free.length === 1 ? "has" : "have"} collateral and no debt.`);
  return parts.length ? parts.join(" ") : null;
}

/** Sources that did not answer, or null when all did. */
export function unreadLine(line: DistanceLine): string | null {
  if (line.unread.length === 0) return null;
  return `Not read: ${joined(line.unread)}. ${line.unread.length === 1 ? "Its positions are" : "Their positions are"} missing from this reading, and nothing counts them as zero.`;
}

/** Everyone but the nearest, in two lines. */
export function restLines(entries: LineEntry[]): [string, string] {
  const [next, ...others] = entries;
  if (!next) return ["No other position at this address.", ""];
  const place = next.distance === null ? "no distance reported" : percent(next.distance);
  const tail = others.length === 0 ? "Nothing behind it." : `${countWord(others.length)} more behind it.`;
  return [`Next: ${shortName(next)}, ${place}.`, tail];
}

export interface Figures {
  id: string;
  position: string;
  distance: string;
  meaning: string;
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
    meaning: entry.distance === null ? "" : meaningOf(entry),
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
    meaning: entry.distance === null ? "" : meaningOf(entry),
    health: `${perp.side === "long" ? "Long" : "Short"}, ${perp.leverage}x`,
    healthNote: ` ${perp.margin}`,
    size: usd(perp.notionalUsd),
    backing: perp.margin === "cross" ? "shared margin" : `${usd(perp.marginUsedUsd)} own margin`,
    backingQuiet: perp.margin === "cross",
    liquidatesAt: perp.liquidationPrice === null ? "none reported" : dollars(perp.liquidationPrice),
    liquidatesNote: "",
    repay: "does not apply",
    repayStruck: false,
    repayQuiet: true,
    levee: entry.reachLabel,
    readAt: readAt === null ? "not read" : clock(readAt),
  };
}

export function figuresFor(line: DistanceLine, report: RiskReport): Figures[] {
  return line.entries.map((entry) => (entry.kind === "aave" ? aaveFigures(entry) : perpFigures(entry, report.hyperliquid.readAt)));
}

export interface CrisisModel {
  name: string;
  percent: string;
  /** Levee cannot reach it. */
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

export function crisisFor(line: DistanceLine): CrisisModel | null {
  const entry = line.crisis;
  if (!entry) return null;
  const others = line.entries.filter((other) => other !== entry);
  return {
    name: entry.name,
    percent: percent(entry.distance ?? 0),
    hollow: entry.reach === "none" || entry.reach === "uncovered",
    rest: restLines(others),
    ...(entry.kind === "aave" ? aaveCrisis(entry) : perpCrisis(entry)),
  };
}

/** The source and moment of a reading. */
export function readingLine(entry: LineEntry, report: RiskReport): string {
  if (entry.kind === "aave") return `${entry.name}, at block ${integer(entry.market.blockNumber ?? 0)}.`;
  return `Hyperliquid, at ${report.hyperliquid.readAt === null ? "an unknown time" : clock(report.hyperliquid.readAt)}.`;
}

/**
 * Which Aave positions are under the trigger the backtest used, and what a repay to target would
 * take. `strong` is the part to set in bold. Null without a trigger.
 */
export function triggerSentence(line: DistanceLine, trigger: number | null): { strong: string; rest: string } | null {
  if (trigger === null) return null;
  const aave = line.entries.filter((entry): entry is AaveEntry => entry.kind === "aave" && entry.position.healthFactor !== null);
  const t = trigger.toFixed(2);
  const used = `, the trigger the backtest used.`;
  if (aave.length === 0) return { strong: "No Aave debt here", rest: ", and Levee repays only on Aave." };
  const under = aave.filter((entry) => (entry.position.healthFactor as number) < trigger);
  const first = under.find((entry) => (entry.reach === "repays" || entry.reach === "part") && (entry.position.repay?.usd ?? 0) > 0);
  const repay = first?.position.repay;
  const tail = first && repay ? ` Repaying ${usd(repay.usd)} would bring ${first.name} to ${repay.target.toFixed(2)}.` : "";
  if (under.length === 0) return { strong: `No Aave position here is under ${t}`, rest: used };
  if (under.length === 1) return { strong: `${(under[0] as AaveEntry).name} is under ${t}`, rest: `${used}${tail}` };
  const count = under.length === 2 && aave.length === 2 ? "Both" : countWord(under.length);
  return { strong: `${count} Aave positions are under ${t}`, rest: `${used}${tail}` };
}

/** How to read the distances at this address, and whose it is. */
export function directionSentence(report: RiskReport): string {
  const sides = new Set(report.hyperliquid.positions.map((perp) => perp.side));
  const aave = [report.aave.base, report.aave.arbitrum].some((market) => market.position?.healthFactor != null);
  const perps = sides.size === 2 ? "for Hyperliquid shorts a rise in price and for longs a fall" : sides.has("short") ? "for the Hyperliquid shorts a rise in price" : sides.has("long") ? "for the Hyperliquid longs a fall in price" : "";
  let lead = "";
  if (aave && perps) lead = `For Aave the distance is a fall in collateral price, ${perps}. `;
  else if (aave) lead = "For Aave the distance is a fall in collateral price. ";
  else if (perps) lead = `On Hyperliquid the distance is ${sides.size === 2 ? "a rise in price for shorts and a fall for longs" : sides.has("short") ? "a rise in price" : "a fall in price"}. `;
  return `${lead}Levee has no relationship with this address, and nothing is repaying it.`;
}

/** The position Levee could act on first, if any: the first Aave position with a distance. */
export function firstAave(line: DistanceLine): AaveEntry | null {
  return line.entries.find((entry): entry is AaveEntry => entry.kind === "aave" && entry.distance !== null) ?? null;
}
