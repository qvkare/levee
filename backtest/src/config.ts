// Pinned inputs for the backtest. Everything the fetch scripts read comes from here.

export type ChainKey = 'base' | 'arbitrum';

export interface ChainConfig {
  key: ChainKey;
  chainId: number;
  pool: `0x${string}`;
  usdc: `0x${string}`;
  /** Free keyless endpoints that serve `eth_call` at the window blocks, measured on 2026-11-07. */
  archiveRpcs: string[];
  /** Independent free `eth_getLogs` providers, with the widest chunk each accepts. */
  logRpcs: Array<{ url: string; chunk: number }>;
}

// Pool and USDC addresses are the ones in docs/SPEC.md section 3.
export const CHAINS: Record<ChainKey, ChainConfig> = {
  base: {
    key: 'base',
    chainId: 8453,
    pool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    archiveRpcs: [
      'https://mainnet.base.org',
      'https://base.gateway.tenderly.co',
      'https://rpc.sentio.xyz/base',
      'https://8453.rpc.thirdweb.com',
      'https://base.merkle.io',
      'https://base-public.nodies.app',
      'https://base.drpc.org',
    ],
    logRpcs: [
      { url: 'https://gateway.tenderly.co/public/base', chunk: 1_000 },
      { url: 'https://base.api.pocket.network', chunk: 500 },
      { url: 'https://rpc.sentio.xyz/base', chunk: 1_000 },
    ],
  },
  arbitrum: {
    key: 'arbitrum',
    chainId: 42161,
    pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    archiveRpcs: [
      'https://arbitrum-one.public.blastapi.io',
      'https://arb-one.api.pocket.network',
      'https://arbitrum.gateway.tenderly.co',
      'https://rpc.sentio.xyz/arbitrum-one',
      'https://42161.rpc.thirdweb.com',
      'https://arb-pokt.nodies.app',
    ],
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

// The population, shared-reserve, calm-period and carry parts. The rules are in README.md,
// committed before any Levee result for these parts was computed.

/** Base has made one block every 2 seconds since genesis, so a block follows from a time. */
export const BASE_GENESIS_TIME = 1_686_789_347;
export const BASE_BLOCK_SEC = 2;
export const baseBlockAt = (unix: number): number => Math.ceil((unix - BASE_GENESIS_TIME) / BASE_BLOCK_SEC);

/** WETH on Base, whose AaveOracle price picks the calm period. */
export const BASE_WETH = '0x4200000000000000000000000000000000000006';

export const CALM_RULE = {
  /** First and last UTC midnight read. */
  fromIso: '2025-01-01T00:00:00Z',
  toIso: '2026-11-01T00:00:00Z',
  /** A day moving more than this breaks a run. */
  maxDailyMove: 0.08,
  /** Length of the calm period, taken from the centre of the longest run. */
  days: 30,
} as const;

/** The calm period's id, next to the window ids. */
export const CALM_ID = 'calm';

/** First block with native USDC listed on each pool, found by binary search on getReserveData. */
export const USDC_LISTED_BLOCK: Record<ChainKey, number> = { base: 8_242_475, arbitrum: 106_410_714 };

/** Re-read grid, in blocks: 60 s in the crash windows and 300 s in the calm period. */
export const REREAD_GRID_BLOCKS: Record<ChainKey, { crash: number; calm: number }> = {
  base: { crash: 30, calm: 150 },
  // Arbitrum averaged 0.249 s a block in both windows.
  arbitrum: { crash: 240, calm: 1_200 },
};

/** Interest indexes and USDC rates are read this often inside each period. */
export const INDEX_STEP_SEC = 3_600;
