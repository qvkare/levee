// Pinned inputs for the backtest. Everything the fetch scripts read comes from here.

export type ChainKey = 'base' | 'arbitrum';

export interface ChainConfig {
  key: ChainKey;
  chainId: number;
  pool: `0x${string}`;
  usdc: `0x${string}`;
  /** Free endpoints that need no key. Order is the preference for archive `eth_call`. */
  archiveRpcs: string[];
  /** Free endpoints that serve `eth_getLogs` over wide ranges. */
  logRpcs: string[];
}

// Pool and USDC addresses are the ones in docs/SPEC.md section 3.
export const CHAINS: Record<ChainKey, ChainConfig> = {
  base: {
    key: 'base',
    chainId: 8453,
    pool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    archiveRpcs: ['https://mainnet.base.org', 'https://gateway.tenderly.co/public/base', 'https://base.api.pocket.network'],
    logRpcs: ['https://base.api.pocket.network', 'https://mainnet.base.org'],
  },
  arbitrum: {
    key: 'arbitrum',
    chainId: 42161,
    pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    archiveRpcs: ['https://gateway.tenderly.co/public/arbitrum', 'https://arb-one.api.pocket.network', 'https://arbitrum-one.public.blastapi.io'],
    logRpcs: ['https://gateway.tenderly.co/public/arbitrum', 'https://arb1.arbitrum.io/rpc'],
  },
};

export interface Window {
  id: string;
  label: string;
  /** Inclusive start, UTC. */
  startIso: string;
  /** Exclusive end, UTC. */
  endIso: string;
}

export const WINDOWS: Window[] = [
  { id: '2025-10', label: '2025-10-10 to 2025-10-11', startIso: '2025-10-10T00:00:00Z', endIso: '2025-10-12T00:00:00Z' },
  { id: '2026-02', label: '2026-01-31 to 2026-02-06', startIso: '2026-01-31T00:00:00Z', endIso: '2026-02-07T00:00:00Z' },
];

export const toUnix = (iso: string): number => Math.floor(Date.parse(iso) / 1000);
