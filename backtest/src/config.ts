// Pinned inputs for the backtest. Everything the fetch scripts read comes from here.

export type ChainKey = 'base' | 'arbitrum';

export interface ChainConfig {
  key: ChainKey;
  chainId: number;
  pool: `0x${string}`;
  usdc: `0x${string}`;
  /** Free keyless endpoints that serve `eth_call` at the window blocks, measured on 2026-11-07. */
  archiveRpcs: string[];
  /** Two independent free `eth_getLogs` providers, with the widest chunk each accepts. */
  logRpcs: Array<{ url: string; chunk: number }>;
}

// Pool and USDC addresses are the ones in docs/SPEC.md section 3.
export const CHAINS: Record<ChainKey, ChainConfig> = {
  base: {
    key: 'base',
    chainId: 8453,
    pool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    archiveRpcs: ['https://mainnet.base.org', 'https://base.drpc.org', 'https://base.gateway.tenderly.co'],
    logRpcs: [
      { url: 'https://gateway.tenderly.co/public/base', chunk: 1_000 },
      { url: 'https://base.api.pocket.network', chunk: 500 },
    ],
  },
  arbitrum: {
    key: 'arbitrum',
    chainId: 42161,
    pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    archiveRpcs: ['https://arbitrum-one.public.blastapi.io', 'https://arb-one.api.pocket.network', 'https://arbitrum.gateway.tenderly.co'],
    logRpcs: [
      { url: 'https://gateway.tenderly.co/public/arbitrum', chunk: 20_000 },
      { url: 'https://arb1.arbitrum.io/rpc', chunk: 20_000 },
    ],
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
