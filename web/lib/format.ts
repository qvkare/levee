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
