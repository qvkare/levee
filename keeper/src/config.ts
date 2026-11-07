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

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const DEFAULT_POSITIONS_FILE = 'keeper/positions.json';

const positionsFileSchema = z.object({
  positions: z
    .array(
      z.object({
        id: z.number().int().nonnegative(),
        trigger: z.string(),
        target: z.string(),
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

function positionTarget(entry: { id: number; trigger: string; target: string }): PositionTarget {
  const triggerWad = parseWad(entry.trigger);
  const targetWad = parseWad(entry.target);
  if (triggerWad <= WAD) {
    throw new Error(`position ${entry.id}: trigger ${entry.trigger} must be above 1, where Aave liquidates`);
  }
  if (targetWad <= triggerWad) {
    throw new Error(`position ${entry.id}: target ${entry.target} must be above trigger ${entry.trigger}`);
  }
  return { ...entry, triggerWad, targetWad };
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
