/** Reads one Hyperliquid account from the public info API. */
import type { Address } from "viem";
import { NO_ACCOUNT, buildAccount, type DexState, type RawClearinghouse, type RawSpot } from "./hyperliquid-model.ts";
import type { Failure, HyperliquidAccount } from "./types.ts";

const DEFAULT_INFO_URL = "https://api.hyperliquid.xyz/info";
const REQUEST_TIMEOUT_MS = 5000;
const DEX_TABLE_TTL_MS = 60 * 60 * 1000;

class InfoError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`info ${status}`);
    this.status = status;
  }
}

async function info<T>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch(process.env.RISK_HYPERLIQUID_INFO_URL || DEFAULT_INFO_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new InfoError(response.status);
  return response.json() as Promise<T>;
}

interface DexEntry {
  dex: string;
  collateralToken: number;
}

const MAIN_DEX_ONLY: DexEntry[] = [{ dex: "", collateralToken: 0 }];
let dexTable: { entries: DexEntry[]; expires: number } | null = null;

/** The list of perp DEXs and what each settles in. It changes rarely, so it is kept for an hour. */
async function readDexTable(): Promise<DexEntry[] | null> {
  if (dexTable && dexTable.expires > Date.now()) return dexTable.entries;
  try {
    const [dexes, metas] = await Promise.all([
      info<Array<{ name: string } | null>>({ type: "perpDexs" }),
      info<Array<{ collateralToken: number }>>({ type: "allPerpMetas" }),
    ]);
    const entries = dexes.map((entry, index) => ({ dex: entry?.name ?? "", collateralToken: metas[index]?.collateralToken ?? 0 }));
    dexTable = { entries, expires: Date.now() + DEX_TABLE_TTL_MS };
    return entries;
  } catch {
    return null;
  }
}

export async function readHyperliquidAccount(user: Address): Promise<{ account: HyperliquidAccount; failures: Failure[] }> {
  const source = "hyperliquid" as const;
  const table = await readDexTable();
  const entries = table ?? MAIN_DEX_ONLY;
  const [abstraction, spot, ...states] = await Promise.allSettled([
    info<string>({ type: "userAbstraction", user }),
    info<RawSpot>({ type: "spotClearinghouseState", user }),
    ...entries.map(({ dex }) => info<RawClearinghouse>({ type: "clearinghouseState", user, dex })),
  ]);

  const main = states[0];
  if (main?.status !== "fulfilled") {
    const limited = main?.reason instanceof InfoError && main.reason.status === 429;
    const reason = limited ? "Hyperliquid rate limited this server" : "Hyperliquid did not answer";
    return { account: NO_ACCOUNT, failures: [{ source, message: `${reason}. Hyperliquid figures are missing, not zero.` }] };
  }

  const dexes: DexState[] = [];
  const missed: string[] = [];
  states.forEach((result, index) => {
    const entry = entries[index] as DexEntry;
    if (result.status === "fulfilled") dexes.push({ ...entry, state: result.value as RawClearinghouse });
    else missed.push(entry.dex);
  });

  const failures: Failure[] = [];
  if (!table) failures.push({ source, message: "The list of Hyperliquid DEXs was not read, so only the main DEX is shown." });
  if (missed.length) failures.push({ source, message: `These Hyperliquid DEXs did not answer, so their positions are missing: ${missed.join(", ")}.` });
  if (abstraction.status !== "fulfilled") failures.push({ source, message: "The Hyperliquid account mode was not read, so no margin ratio is shown." });
  if (spot.status !== "fulfilled") failures.push({ source, message: "The Hyperliquid spot balance was not read. A unified account shows no margin ratio without it." });

  const account = buildAccount({
    abstraction: abstraction.status === "fulfilled" ? abstraction.value : null,
    spot: spot.status === "fulfilled" ? spot.value : null,
    dexes,
  });
  return { account: { ...account, status: failures.length ? "partial" : "ok" }, failures };
}
