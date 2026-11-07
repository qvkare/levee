/** Joins the contract's view of a position to the keeper's, and refuses a bad setup. */
import { type Address, getAddress } from 'viem';
import { type ChainInfo, chainInfo } from './chains.js';
import type { KeeperConfig } from './config.js';
import { deriveChildKey, publicKeyToAddress, rescuerPath } from './derive.js';
import { type EvmClient, createEvmClient } from './evm.js';
import type { NearRescuer, NearViews, Position } from './near.js';
import { DEFAULT_QUORUM } from './quorum.js';
import type { PositionTarget, RescueContext } from './rescue.js';

export interface Wiring {
  target: PositionTarget;
  chain: ChainInfo;
  position: Position;
  borrower: Address;
  rescuer: Address;
  clients: EvmClient[];
}

/**
 * Reads the position and derives its rescuer. The local derivation must equal the
 * MPC contract's answer: the broadcast gate trusts this address, so it is checked
 * against the live contract once at start rather than taken from either side alone.
 */
export async function wirePosition(
  config: KeeperConfig,
  views: NearViews,
  target: PositionTarget,
  makeClient: (url: string) => EvmClient = createEvmClient,
): Promise<Wiring> {
  const position = await views.getPosition(target.id);
  const chain = chainInfo(position.chain_id);
  if (chain.network !== config.network) {
    throw new Error(
      `position ${target.id} is on ${chain.name}, which is not a ${config.network} chain`,
    );
  }

  const urls = config.rpcUrls(chain);
  if (urls.length < DEFAULT_QUORUM.minEndpoints) {
    throw new Error(
      `${chain.rpcEnv} lists ${urls.length} endpoint(s), and quorum needs ${DEFAULT_QUORUM.minEndpoints}`,
    );
  }

  const path = rescuerPath(target.id);
  const [root, live] = await Promise.all([
    views.rootPublicKey(),
    views.derivedPublicKey(path, config.contract),
  ]);
  const derived = deriveChildKey(root, config.contract, path);
  if (derived !== live) {
    throw new Error(`local derivation ${derived} differs from ${config.mpc}: ${live}`);
  }

  return {
    target,
    chain,
    position,
    borrower: getAddress(position.borrower),
    rescuer: publicKeyToAddress(derived),
    clients: urls.map((url) => makeClient(url)),
  };
}

export function rescueContext(options: {
  config: KeeperConfig;
  wiring: Wiring;
  views: NearViews;
  near: NearRescuer;
  log: (message: string) => void;
}): RescueContext {
  const { config, wiring, views, near, log } = options;
  return {
    network: config.network,
    chain: wiring.chain,
    position: wiring.target,
    borrower: wiring.borrower,
    rescuer: wiring.rescuer,
    nearContract: config.contract,
    clients: wiring.clients,
    near,
    views,
    ceilings: config.feeCeilings(wiring.chain),
    evidenceDir: config.evidenceDir,
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log,
  };
}

/** `rescue` rule 1 would reject a stranger on every attempt, so fail before watching. */
export function assertIsKeeper(wiring: Wiring, accountId: string): void {
  if (wiring.position.keeper !== accountId) {
    throw new Error(
      `position ${wiring.target.id} has keeper ${wiring.position.keeper}, not ${accountId}`,
    );
  }
}
