/** The public, keyless reads behind `verify`. */
import type { Address, Hex } from 'viem';
import { type Network, chainInfo } from './chains.js';
import { deriveChildKey, publicKeyToAddress, rescuerPath } from './derive.js';
import { type EvmClient, createEvmClient } from './evm.js';
import {
  MPC_CONTRACTS,
  NEAR_RPC_URLS,
  createNearViews,
  readNearTransaction,
} from './near.js';
import type { ChainLookup, Lookups, NearLookup } from './verify.js';

export const parseUrlList = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter((url) => url !== '');

const unique = (urls: string[]): string[] => [...new Set(urls)];

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The first endpoint with an answer. Null only if some endpoint really had none. */
async function firstAnswer<T>(
  clients: EvmClient[],
  read: (client: EvmClient) => Promise<T | null>,
): Promise<T | null> {
  const errors: string[] = [];
  let answeredNull = false;
  for (const client of clients) {
    try {
      const value = await read(client);
      if (value !== null) return value;
      answeredNull = true;
    } catch (error) {
      errors.push(`${client.url}: ${describeError(error)}`);
    }
  }
  if (answeredNull) return null;
  throw new Error(`no RPC answered: ${errors.join('; ')}`);
}

function chainLookup(urls: string[]): ChainLookup {
  const clients = urls.map(createEvmClient);
  return {
    transaction: (hash: Hex) => firstAnswer(clients, (client) => client.readTransaction(hash)),
    receipt: (hash: Hex) => firstAnswer(clients, (client) => client.readReceipt(hash)),
  };
}

function nearLookup(network: Network, urls: string[]): NearLookup {
  const mpc = MPC_CONTRACTS[network];
  return {
    transaction: (nearTx, sender) => readNearTransaction(urls, nearTx, sender),

    async position(contract, id, blockHash) {
      const views = urls.map((rpcUrl) => createNearViews({ rpcUrl, contract, mpc }));
      for (const view of views) {
        try {
          return { position: await view.getPosition(id, blockHash), asOf: 'block' };
        } catch {
          // Pruned nodes do not have old state, so the next endpoint is worth trying.
        }
      }
      for (const view of views) {
        try {
          return { position: await view.getPosition(id), asOf: 'latest' };
        } catch {
          // Reported below if every endpoint fails.
        }
      }
      throw new Error(`could not read position ${id} on ${contract}`);
    },

    async rescuerAddress(contract, id): Promise<Address> {
      const rpcUrl = urls[0];
      if (!rpcUrl) throw new Error(`no NEAR RPC for ${network}`);
      const views = createNearViews({ rpcUrl, contract, mpc });
      const path = rescuerPath(id);
      const [root, live] = await Promise.all([
        views.rootPublicKey(),
        views.derivedPublicKey(path, contract),
      ]);
      const derived = deriveChildKey(root, contract, path);
      if (derived !== live) {
        throw new Error(`local derivation ${derived} differs from ${mpc}: ${live}`);
      }
      return publicKeyToAddress(derived);
    },
  };
}

/**
 * Public endpoints work with no setup. Configured ones go first, and a configured
 * endpoint for another chain just fails to resolve the hash and falls through.
 */
export function createLookups(env: NodeJS.ProcessEnv): Lookups {
  return {
    chain(chainId) {
      const chain = chainInfo(chainId);
      return chainLookup(unique([...parseUrlList(env[chain.rpcEnv]), ...chain.publicRpcs]));
    },
    near(network) {
      const configured = env.NEAR_NETWORK === network ? parseUrlList(env.NEAR_RPC_URL) : [];
      return nearLookup(network, unique([...configured, ...NEAR_RPC_URLS[network]]));
    },
  };
}
