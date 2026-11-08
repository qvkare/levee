/** Display formats. One fixed locale and UTC only, so server and browser print the same text. */

const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const cents = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function usd(value: number): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  return `${sign}$${abs >= 1000 ? whole.format(abs) : cents.format(abs)}`;
}

/** Rounded down: a printed reading should not look healthier than the real one. */
function floorTo(value: number, digits: number): string {
  const factor = 10 ** digits;
  return (Math.floor(value * factor + 1e-9) / factor).toFixed(digits);
}

/** A health factor or margin ratio. */
export function ratio(value: number): string {
  if (value >= 1000) return whole.format(Math.floor(value));
  return value >= 100 ? floorTo(value, 1) : floorTo(value, 3);
}

/** A fraction as a percentage, rounded down. */
export function percent(fraction: number): string {
  return `${floorTo(fraction * 100, 1)}%`;
}

/** A count out of a total, in percent to one decimal and rounded, as the backtest's own summary prints it. */
export function countShare(count: number, total: number): string {
  return ((count / total) * 100).toFixed(1);
}

/** Share of a total, for thresholds, rounded to the nearest tenth. */
export function share(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/** Enough digits to tell a price from its neighbours, from BTC down to meme coins. */
export function price(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 1 : abs >= 1 ? 3 : abs >= 0.01 ? 5 : 8;
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits }).format(value);
}

export function amount(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value);
}

export function integer(value: string | number): string {
  return whole.format(Number(value));
}

export function utcTime(iso: string | number): string {
  const date = new Date(iso);
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 19)} UTC`;
}

/** A price with a dollar sign, in as many digits as the size of the number needs. */
export function dollars(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 100_000) return `$${whole.format(value)}`;
  if (abs >= 1) return `$${cents.format(value)}`;
  return `$${new Intl.NumberFormat("en-US", { maximumSignificantDigits: 4 }).format(value)}`;
}

/** Backtest dollars as the backtest prints them: $1.40M, $780.8k, $9.1k, $427. */
export function usdShort(value: number): string {
  const sign = value < 0 ? "−" : "";
  const abs = Math.abs(value);
  if (abs >= 999_950) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1000) return `${sign}$${(abs / 1e3).toFixed(1)}k`;
  return `${sign}$${Math.round(abs)}`;
}

/** A net figure, with its sign either way: +$174.7k, −$122.0k. */
export function signedUsdShort(value: number): string {
  return value > 0 ? `+${usdShort(value)}` : usdShort(value);
}

/** A threshold or bonus with no needless zero: 84%, 5%, 77.5%. */
export function plainShare(fraction: number): string {
  return `${Number((fraction * 100).toFixed(1))}%`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 7 Nov 2026, 19:22 UTC. Built by hand, so a server in any locale prints the same text. */
export function readDate(iso: string | number): string {
  const date = new Date(iso);
  const time = date.toISOString().slice(11, 16);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${time} UTC`;
}

/** 7 Nov 2026, 19:27:38 UTC. */
export function readSecond(iso: string | number): string {
  const date = new Date(iso);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${date.toISOString().slice(11, 19)} UTC`;
}

/** 19:22:40 UTC. */
export function clock(iso: string | number): string {
  return `${new Date(iso).toISOString().slice(11, 19)} UTC`;
}

const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve"];

/** Spelled out up to twelve, as the sentence around it expects. */
export function countWord(count: number): string {
  return WORDS[count] ?? integer(count);
}

/** a, b and c */
export function joined(items: string[]): string {
  if (items.length < 2) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Seconds from milliseconds, to one decimal. A shorter time says so, and does not print zero. */
export function seconds(milliseconds: number): string {
  return milliseconds < 100 ? "under 0.1 s" : `${(milliseconds / 1000).toFixed(1)} s`;
}
