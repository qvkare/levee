import type { Address } from 'viem';

export type Network = 'mainnet' | 'testnet';

export interface ChainInfo {
  chainId: number;
  /** Used in run ids, as in `2026-11-09T10-12-03Z-base-1`. */
  name: string;
  network: Network;
  pool: Address;
  usdc: Address;
  /** Environment variable holding the keeper's RPC list. */
  rpcEnv: 'BASE_RPC_URLS' | 'ARBITRUM_RPC_URLS';
  /** Public endpoints `verify` can fall back on, so that it works with no setup. */
  publicRpcs: string[];
}

/** Spec section 3. */
export const CHAINS: Record<number, ChainInfo> = {
  8453: {
    chainId: 8453,
    name: 'base',
    network: 'mainnet',
    pool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    rpcEnv: 'BASE_RPC_URLS',
    publicRpcs: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
  },
  42161: {
    chainId: 42161,
    name: 'arbitrum',
    network: 'mainnet',
    pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    rpcEnv: 'ARBITRUM_RPC_URLS',
    publicRpcs: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'],
  },
  84532: {
    chainId: 84532,
    name: 'base-sepolia',
    network: 'testnet',
    pool: '0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27',
    usdc: '0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f',
    rpcEnv: 'BASE_RPC_URLS',
    publicRpcs: ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com'],
  },
  421614: {
    chainId: 421614,
    name: 'arbitrum-sepolia',
    network: 'testnet',
    pool: '0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff',
    usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    rpcEnv: 'ARBITRUM_RPC_URLS',
    publicRpcs: [
      'https://sepolia-rollup.arbitrum.io/rpc',
      'https://arbitrum-sepolia-rpc.publicnode.com',
    ],
  },
};

export function chainInfo(chainId: number): ChainInfo {
  const chain = CHAINS[chainId];
  if (!chain) throw new Error(`chain ${chainId} is not in spec section 3`);
  return chain;
}
