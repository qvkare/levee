/** Reads one Aave market. Every call runs at one pinned block, so the read can be repeated exactly. */
import { createPublicClient, fallback, formatUnits, http, parseAbi, type Address, type PublicClient } from "viem";
import { arbitrum, base } from "viem/chains";
import { buildPosition, rayMul, type AccountData } from "./aave-model.ts";
import { CHAINS, rpcUrls, type ChainConfig } from "./chains.ts";
import type { AaveMarket, ChainKey, Failure, ReserveLine, Reserves } from "./types.ts";

const POOL_ABI = parseAbi([
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
  "function getReserveNormalizedIncome(address asset) view returns (uint256)",
  "function getReserveNormalizedVariableDebt(address asset) view returns (uint256)",
]);
const UI_ABI = parseAbi([
  "struct UserReserveData { address underlyingAsset; uint256 scaledATokenBalance; bool usageAsCollateralEnabledOnUser; uint256 scaledVariableDebt; }",
  "function getUserReservesData(address provider, address user) view returns (UserReserveData[] memory, uint8)",
]);
const ORACLE_ABI = parseAbi(["function getAssetPrice(address asset) view returns (uint256)"]);
const ERC20_ABI = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
const MULTICALL_ABI = parseAbi(["function getCurrentBlockTimestamp() view returns (uint256)"]);

const VIEM_CHAINS = { base, arbitrum } as const;
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const REQUEST_TIMEOUT_MS = 4000;

/** A client per read: viem shares in-flight promises inside a client, which Workers requests must not. */
function clientFor(chain: ChainConfig): PublicClient {
  const transport = fallback(rpcUrls(chain).map((url) => http(url, { timeout: REQUEST_TIMEOUT_MS, retryCount: 0 })));
  return createPublicClient({ chain: VIEM_CHAINS[chain.key], transport }) as PublicClient;
}

async function readReserves(client: PublicClient, chain: ChainConfig, blockNumber: bigint, user: Address): Promise<Reserves> {
  const [lines, eModeCategory] = await client.readContract({
    address: chain.uiPoolDataProvider,
    abi: UI_ABI,
    functionName: "getUserReservesData",
    args: [chain.addressesProvider, user],
    blockNumber,
  });
  const held = lines.filter(
    (line) => (line.scaledATokenBalance > 0n && line.usageAsCollateralEnabledOnUser) || line.scaledVariableDebt > 0n,
  );
  if (held.length === 0) return { collateral: [], debt: [], eModeCategory };

  const reads = held.flatMap((line) => {
    const asset = line.underlyingAsset;
    return [
      { address: chain.pool, abi: POOL_ABI, functionName: "getReserveNormalizedIncome", args: [asset] },
      { address: chain.pool, abi: POOL_ABI, functionName: "getReserveNormalizedVariableDebt", args: [asset] },
      { address: chain.oracle, abi: ORACLE_ABI, functionName: "getAssetPrice", args: [asset] },
      { address: asset, abi: ERC20_ABI, functionName: "decimals" },
      { address: asset, abi: ERC20_ABI, functionName: "symbol" },
    ] as const;
  });
  const results = await client.multicall({ contracts: reads, allowFailure: true, blockNumber, batchSize: 0 });

  const collateral: ReserveLine[] = [];
  const debt: ReserveLine[] = [];
  held.forEach((line, i) => {
    const [income, variableDebt, oraclePrice, decimals, symbol] = results.slice(i * 5, i * 5 + 5);
    if (!income || income.status !== "success" || !variableDebt || variableDebt.status !== "success") throw new Error("reserve index read failed");
    if (!oraclePrice || oraclePrice.status !== "success" || !decimals || decimals.status !== "success") throw new Error("reserve price read failed");
    const asset = line.underlyingAsset;
    const label = symbol?.status === "success" ? String(symbol.result) : `${asset.slice(0, 6)}…`;
    const entry = (raw: bigint): ReserveLine => {
      const amount = Number(formatUnits(raw, Number(decimals.result)));
      return {
        asset,
        symbol: label,
        amount,
        usd: amount * (Number(oraclePrice.result as bigint) / 1e8),
        stable: chain.stablecoins.has(asset.toLowerCase()),
      };
    };
    if (line.scaledATokenBalance > 0n && line.usageAsCollateralEnabledOnUser) {
      collateral.push(entry(rayMul(line.scaledATokenBalance, income.result as bigint)));
    }
    if (line.scaledVariableDebt > 0n) debt.push(entry(rayMul(line.scaledVariableDebt, variableDebt.result as bigint)));
  });
  const byValue = (a: ReserveLine, b: ReserveLine) => b.usd - a.usd;
  return { collateral: collateral.sort(byValue), debt: debt.sort(byValue), eModeCategory };
}

export function emptyMarket(key: ChainKey): AaveMarket {
  const chain = CHAINS[key];
  return { status: "unavailable", chain: key, chainId: chain.chainId, pool: chain.pool, blockNumber: null, blockTimestamp: null, position: null };
}

export async function readAaveMarket(key: ChainKey, user: Address, target: number): Promise<{ market: AaveMarket; failures: Failure[] }> {
  const chain = CHAINS[key];
  const source = `aave.${key}` as const;
  try {
    const client = clientFor(chain);
    const blockNumber = (await client.getBlockNumber({ cacheTime: 0 })) - chain.blockLag;
    const [account, timestamp] = await client.multicall({
      contracts: [
        { address: chain.pool, abi: POOL_ABI, functionName: "getUserAccountData", args: [user] },
        { address: MULTICALL3, abi: MULTICALL_ABI, functionName: "getCurrentBlockTimestamp" },
      ],
      allowFailure: true,
      blockNumber,
      batchSize: 0,
    });
    if (account.status !== "success") throw new Error("getUserAccountData failed");

    const failures: Failure[] = [];
    let reserves: Reserves | null = null;
    const hasPosition = account.result[0] > 0n || account.result[1] > 0n;
    if (hasPosition) {
      try {
        reserves = await readReserves(client, chain, blockNumber, user);
      } catch {
        failures.push({ source, message: `Per-asset detail on ${chain.label} was not read. Totals and health factor are unaffected.` });
      }
    }
    const position = buildPosition(account.result as AccountData, reserves, chain.usdc, target);
    return {
      market: {
        ...emptyMarket(key),
        status: failures.length ? "partial" : "ok",
        blockNumber: blockNumber.toString(),
        blockTimestamp: timestamp.status === "success" ? Number(timestamp.result) : null,
        position,
      },
      failures,
    };
  } catch {
    // Errors from the transport can quote the RPC URL, which may hold a key. None are passed on.
    return {
      market: emptyMarket(key),
      failures: [{ source, message: `${chain.label} RPC did not answer. ${chain.label} figures are missing, not zero.` }],
    };
  }
}
