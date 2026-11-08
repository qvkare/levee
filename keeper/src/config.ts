/**
 * Keeper configuration. Keys and RPC lists come from the environment, and the trigger
 * and target for each position come from a file, since neither belongs on chain.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { ChainInfo, Network } from './chains.js';
import { WAD, parseWad } from './decision.js';
import { DEFAULT_EVIDENCE_DIR } from './evidence.js';
import type { FeeCeilings } from './fees.js';
import { parseUrlList } from './lookups.js';
import { MPC_CONTRACTS, NEAR_RPC_URLS } from './near.js';
import type { PositionTarget } from './rescue.js';
import { DEFAULT_QUOTE_TOLERANCE_BPS } from './unwind.js';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const DEFAULT_POSITIONS_FILE = 'keeper/positions.json';

/** `LeveeUnwind.authorize` takes `0 < maxSlippageBps <= 300`. */
export const MAX_SLIPPAGE_BPS = 300;

/** A tolerance over the quote beyond the borrower's own bound would do nothing. */
export const MAX_QUOTE_TOLERANCE_BPS = MAX_SLIPPAGE_BPS;

const positionsFileSchema = z.object({
  positions: z
    .array(
      z.object({
        id: z.number().int().nonnegative(),
        trigger: z.string(),
        target: z.string(),
        /** Spec section 9. Absent means reserve, as every position was before v0.2. */
        mode: z.enum(['reserve', 'collateral']).optional(),
        /** Collateral mode only. Must equal what the borrower set at the helper. */
        max_slippage_bps: z.number().int().optional(),
        /**
         * Collateral mode only: headroom over a fresh QuoterV2 quote when the keeper
         * sets `max_sold`. Defaults to 50 bps.
         */
        quote_tolerance_bps: z.number().int().optional(),
      }),
    )
    .min(1),
  /** Per chain id. The contract has no view for its ceilings, so they are repeated here. */
  fee_ceilings: z.record(
    z.string(),
    z.object({
      max_fee_per_gas: z.string().regex(/^\d+$/),
      max_priority_fee_per_gas: z.string().regex(/^\d+$/),
    }),
  ),
});

export interface KeeperConfig {
  network: Network;
  contract: string;
  mpc: string;
  nearRpcUrl: string;
  positions: PositionTarget[];
  evidenceDir: string;
  rpcUrls(chain: ChainInfo): string[];
  feeCeilings(chain: ChainInfo): FeeCeilings;
}

export interface KeeperCredentials {
  accountId: string;
  privateKey: string;
}

export function parseNetwork(value: string | undefined): Network {
  const network = value === undefined || value === '' ? 'testnet' : value;
  if (network !== 'mainnet' && network !== 'testnet') {
    throw new Error(`NEAR_NETWORK must be mainnet or testnet, got ${network}`);
  }
  return network;
}

type PositionEntry = z.infer<typeof positionsFileSchema>['positions'][number];

function positionTarget(entry: PositionEntry): PositionTarget {
  const { id, trigger, target } = entry;
  const triggerWad = parseWad(trigger);
  const targetWad = parseWad(target);
  if (triggerWad <= WAD) {
    throw new Error(`position ${id}: trigger ${trigger} must be above 1, where Aave liquidates`);
  }
  if (targetWad <= triggerWad) {
    throw new Error(`position ${id}: target ${target} must be above trigger ${trigger}`);
  }
  const base = { id, trigger, target, triggerWad, targetWad };
  const slippage = entry.max_slippage_bps;
  const tolerance = entry.quote_tolerance_bps;
  if (entry.mode !== 'collateral') {
    if (slippage !== undefined) {
      throw new Error(`position ${id}: max_slippage_bps applies only to mode "collateral"`);
    }
    if (tolerance !== undefined) {
      throw new Error(`position ${id}: quote_tolerance_bps applies only to mode "collateral"`);
    }
    return base;
  }
  if (slippage === undefined || slippage <= 0 || slippage > MAX_SLIPPAGE_BPS) {
    throw new Error(
      `position ${id}: collateral mode needs max_slippage_bps above 0 and at most ${MAX_SLIPPAGE_BPS}, as the borrower set it at the helper`,
    );
  }
  if (tolerance !== undefined && (tolerance < 0 || tolerance > MAX_QUOTE_TOLERANCE_BPS)) {
    throw new Error(
      `position ${id}: quote_tolerance_bps must be from 0 to ${MAX_QUOTE_TOLERANCE_BPS}`,
    );
  }
  return {
    ...base,
    mode: 'collateral',
    maxSlippageBps: BigInt(slippage),
    quoteToleranceBps: tolerance === undefined ? DEFAULT_QUOTE_TOLERANCE_BPS : BigInt(tolerance),
  };
}

export function parsePositionsFile(text: string) {
  const file = positionsFileSchema.parse(JSON.parse(text));
  const ids = file.positions.map((position) => position.id);
  if (new Set(ids).size !== ids.length) throw new Error('a position id is listed twice');
  return { positions: file.positions.map(positionTarget), feeCeilings: file.fee_ceilings };
}

export const evidenceDirFrom = (env: NodeJS.ProcessEnv): string =>
  env.EVIDENCE_DIR || DEFAULT_EVIDENCE_DIR;

/** Everything a read-only command needs. Asks for no keys. */
export async function loadConfig(env: NodeJS.ProcessEnv): Promise<KeeperConfig> {
  const network = parseNetwork(env.NEAR_NETWORK);
  const contract = env.LEVEE_CONTRACT;
  if (!contract) throw new Error('LEVEE_CONTRACT is not set');

  const file = env.KEEPER_CONFIG || DEFAULT_POSITIONS_FILE;
  const path = isAbsolute(file) ? file : join(REPO_ROOT, file);
  const { positions, feeCeilings } = parsePositionsFile(await readFile(path, 'utf8'));

  const nearRpcUrl = env.NEAR_RPC_URL || NEAR_RPC_URLS[network][0];
  if (!nearRpcUrl) throw new Error(`no NEAR RPC for ${network}`);

  return {
    network,
    contract,
    mpc: MPC_CONTRACTS[network],
    nearRpcUrl,
    positions,
    evidenceDir: evidenceDirFrom(env),
    rpcUrls: (chain) => [...new Set(parseUrlList(env[chain.rpcEnv]))],
    feeCeilings(chain) {
      const ceilings = feeCeilings[String(chain.chainId)];
      if (!ceilings) throw new Error(`no fee_ceilings for chain ${chain.chainId} in ${path}`);
      return {
        maxFeePerGas: BigInt(ceilings.max_fee_per_gas),
        maxPriorityFeePerGas: BigInt(ceilings.max_priority_fee_per_gas),
      };
    },
  };
}

/** Only `run` and `rescue-once` call this. */
export function loadCredentials(env: NodeJS.ProcessEnv): KeeperCredentials {
  const accountId = env.KEEPER_ACCOUNT;
  const privateKey = env.KEEPER_PRIVATE_KEY;
  if (!accountId || !privateKey) {
    throw new Error('KEEPER_ACCOUNT and KEEPER_PRIVATE_KEY must be set');
  }
  return { accountId, privateKey };
}
