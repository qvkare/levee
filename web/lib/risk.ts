/** The one read behind the API and every page. It resolves on any outcome and does not throw. */
import type { Address } from "viem";
import { emptyMarket, readAaveMarket } from "./aave.ts";
import { ttlCache } from "./cache.ts";
import { CHAINS } from "./chains.ts";
import { NO_ACCOUNT } from "./hyperliquid-model.ts";
import { readHyperliquidAccount } from "./hyperliquid.ts";
import { DEFAULT_TARGET } from "./math.ts";
import { assembleReport, withTarget } from "./report.ts";
import type { AaveMarket, ChainKey, Failure, HyperliquidAccount, RiskReport, Status } from "./types.ts";

/** Each source gets this long before it is reported as missing. */
const SOURCE_DEADLINE_MS = 8000;

export const FRESH_SECONDS: Record<Status, number> = { ok: 15, partial: 5, unavailable: 0 };

function withDeadline<T>(work: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), SOURCE_DEADLINE_MS);
  });
  return Promise.race([work.catch(() => fallback), deadline]).finally(() => clearTimeout(timer));
}

function missingMarket(key: ChainKey): { market: AaveMarket; failures: Failure[] } {
  const { label } = CHAINS[key];
  return {
    market: emptyMarket(key),
    failures: [{ source: `aave.${key}`, message: `${label} RPC did not answer in time. ${label} figures are missing, not zero.` }],
  };
}

const MISSING_ACCOUNT: { account: HyperliquidAccount; failures: Failure[] } = {
  account: NO_ACCOUNT,
  failures: [{ source: "hyperliquid", message: "Hyperliquid did not answer in time. Hyperliquid figures are missing, not zero." }],
};

async function readAll(address: Address): Promise<RiskReport> {
  const [base, arbitrum, hyperliquid] = await Promise.all([
    withDeadline(readAaveMarket("base", address, DEFAULT_TARGET), missingMarket("base")),
    withDeadline(readAaveMarket("arbitrum", address, DEFAULT_TARGET), missingMarket("arbitrum")),
    withDeadline(readHyperliquidAccount(address), MISSING_ACCOUNT),
  ]);
  return assembleReport({
    address,
    target: DEFAULT_TARGET,
    generatedAt: new Date().toISOString(),
    base: base.market,
    arbitrum: arbitrum.market,
    hyperliquid: hyperliquid.account,
    failures: [...base.failures, ...arbitrum.failures, ...hyperliquid.failures],
  });
}

const cache = ttlCache<RiskReport>((report) => FRESH_SECONDS[report.status] * 1000, 1000);

export async function getRiskReport(address: Address, target: number = DEFAULT_TARGET): Promise<RiskReport> {
  const report = await cache.get(address, () => readAll(address));
  return target === report.target ? report : withTarget(report, target);
}
