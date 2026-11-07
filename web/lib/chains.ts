/**
 * Aave v3 deployments. Addresses are from bgd-labs/aave-address-book, and on 2026-11-07 each Pool's
 * ADDRESSES_PROVIDER() and each provider's getPriceOracle() were read live and matched.
 */
import type { ChainKey } from "./types.ts";

export interface ChainConfig {
  key: ChainKey;
  label: string;
  chainId: number;
  pool: `0x${string}`;
  addressesProvider: `0x${string}`;
  uiPoolDataProvider: `0x${string}`;
  oracle: `0x${string}`;
  /** Native USDC, the only asset Levee repays. */
  usdc: `0x${string}`;
  explorer: string;
  rpcEnv: string;
  publicRpcs: string[];
  /** Blocks behind head to read at. Public endpoints sit behind load balancers and lag a little. */
  blockLag: bigint;
  /** Reserves treated as stable when checking the 1 - 1/HF assumption. Anything else is volatile. */
  stablecoins: ReadonlySet<string>;
}

const set = (...addresses: string[]) => new Set(addresses.map((a) => a.toLowerCase()));

export const CHAINS: Record<ChainKey, ChainConfig> = {
  base: {
    key: "base",
    label: "Base",
    chainId: 8453,
    pool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    addressesProvider: "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D",
    uiPoolDataProvider: "0x0C6BC4a12039788be08F87e87Cff87FEDbd1D386",
    oracle: "0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    explorer: "https://basescan.org",
    rpcEnv: "RISK_BASE_RPC_URLS",
    publicRpcs: ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.drpc.org"],
    blockLag: 2n,
    stablecoins: set(
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC
      "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", // USDbC
      "0x6Bb7a212910682DCFdbd5BCBb3e28FB4E8da10Ee", // GHO
      "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", // EURC
      "0x660975730059246A68521a3e2FBD4740173100f5", // syrupUSDC
    ),
  },
  arbitrum: {
    key: "arbitrum",
    label: "Arbitrum",
    chainId: 42161,
    pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    addressesProvider: "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb",
    uiPoolDataProvider: "0x91E04cf78e53aEBe609e8a7f2003e7EECD743F2B",
    oracle: "0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    explorer: "https://arbiscan.io",
    rpcEnv: "RISK_ARBITRUM_RPC_URLS",
    publicRpcs: ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com", "https://arbitrum.drpc.org"],
    blockLag: 16n,
    stablecoins: set(
      "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // USDC
      "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8", // USDC.e
      "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", // USDT
      "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", // DAI
      "0x17FC002b466eEc40DaE837Fc4bE5c67993ddBd6F", // FRAX
      "0x93b346b6BC2548dA6A1E7d98E9a421B42541425b", // LUSD
      "0x3F56e0c36d275367b8C502090EDF38289b3dEa0d", // MAI
      "0xD22a58f79e9481D1a88e00c343885A588b34b68B", // EURS
      "0x7dfF72693f6A4149b17e7C6314655f6A9F7c8B33", // GHO
    ),
  },
};

/** Configured URLs first, then the public fallbacks unless they are turned off. */
export function rpcUrls(chain: ChainConfig): string[] {
  const configured = (process.env[chain.rpcEnv] ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  if (process.env.RISK_PUBLIC_RPC_FALLBACK === "off" && configured.length > 0) return configured;
  return [...configured, ...chain.publicRpcs];
}
