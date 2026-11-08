/** Joins the contract's view of a position to the keeper's, and refuses a bad setup. */
import { type Address, getAddress } from 'viem';
import { type ChainInfo, chainInfo } from './chains.js';
import type { KeeperConfig } from './config.js';
import { deriveChildKey, publicKeyToAddress, rescuerPath } from './derive.js';
import { type EvmClient, createEvmClient } from './evm.js';
import type { NearRescuer, NearViews, Position } from './near.js';
import { DEFAULT_QUORUM } from './quorum.js';
import type { CollateralContext, PositionTarget, RescueContext } from './rescue.js';
import { type HelperConfig, helperConfigMismatch } from './unwind.js';

export interface Wiring {
  target: PositionTarget;
  chain: ChainInfo;
  position: Position;
  borrower: Address;
  rescuer: Address;
  clients: EvmClient[];
  /** Collateral mode only. */
  collateral?: CollateralContext & { helperConfig: HelperConfig };
}

/** Every endpoint that answers must give the same config. */
async function readHelperConfig(
  clients: EvmClient[],
  helper: Address,
  borrower: Address,
): Promise<HelperConfig> {
  const reads = await Promise.allSettled(
    clients.map((client) => client.readHelperConfig(helper, borrower)),
  );
  const answers = reads.flatMap((read) => (read.status === 'fulfilled' ? [read.value] : []));
  const [first] = answers;
  if (!first) {
    const errors = reads.map((read) => (read.status === 'rejected' ? String(read.reason) : ''));
    throw new Error(`could not read the helper config at ${helper}: ${errors.join('; ')}`);
  }
  const key = (config: HelperConfig) =>
    `${config.rescuer.toLowerCase()} ${config.maxSlippageBps} ${config.triggerHf} ${config.targetHf} ${config.collateral.toLowerCase()} ${config.poolFee}`;
  if (answers.some((answer) => key(answer) !== key(first))) {
    throw new Error(`endpoints disagree on the helper config at ${helper}`);
  }
  return first;
}

/**
 * Collateral mode needs a collateral config on the contract, a helper and a QuoterV2 on
 * the chain, and a borrower whose settings at the helper are the keeper's and whose
 * collateral and pool fee there are the position's. The helper enforces all of them,
 * so a keeper that disagrees would only waste gas.
 */
async function wireCollateral(
  config: KeeperConfig,
  views: NearViews,
  target: PositionTarget,
  position: Position,
  chain: ChainInfo,
  clients: EvmClient[],
  rescuer: Address,
): Promise<NonNullable<Wiring['collateral']>> {
  if (!position.collateral) {
    throw new Error(
      `position ${target.id} has no collateral config on ${config.contract}, so it cannot run in collateral mode`,
    );
  }
  if (!chain.quoterV2) {
    throw new Error(`no Uniswap v3 QuoterV2 is known for ${chain.name}, so max_sold cannot be quoted`);
  }
  const chainConfig = await views.getChain(chain.chainId);
  if (!chainConfig?.unwind) {
    throw new Error(`${config.contract} has no LeveeUnwind helper for ${chain.name}`);
  }
  const helper = getAddress(chainConfig.unwind);
  const borrower = getAddress(position.borrower);
  const asset = getAddress(position.collateral.asset);
  const poolFee = BigInt(position.collateral.pool_fee);
  const helperConfig = await readHelperConfig(clients, helper, borrower);
  const mismatch = helperConfigMismatch(
    { ...target, collateral: asset, poolFee },
    helperConfig,
    rescuer,
  );
  if (mismatch) {
    throw new Error(`position ${target.id}: the borrower's settings at ${helper} differ: ${mismatch}`);
  }
  return { asset, helper, poolFee, quoter: chain.quoterV2, helperConfig };
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

  const rescuer = publicKeyToAddress(derived);
  const clients = urls.map((url) => makeClient(url));
  const collateral =
    target.mode === 'collateral'
      ? await wireCollateral(config, views, target, position, chain, clients, rescuer)
      : undefined;

  return {
    target,
    chain,
    position,
    borrower: getAddress(position.borrower),
    rescuer,
    clients,
    ...(collateral ? { collateral } : {}),
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
    ...(wiring.collateral
      ? {
          collateral: {
            asset: wiring.collateral.asset,
            helper: wiring.collateral.helper,
            poolFee: wiring.collateral.poolFee,
            quoter: wiring.collateral.quoter,
          },
        }
      : {}),
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
