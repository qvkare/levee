/**
 * NEAR access through near-api-js. `NearRescuer` needs the keeper's function-call key,
 * and everything else is a public view that works with no keys.
 */
import { base58, base64 } from '@scure/base';
import {
  Account,
  JsonRpcProvider,
  type KeyPairString,
  actions,
  getTransactionLastResult,
  teraToGas,
} from 'near-api-js';
import {
  InvalidNonceError,
  InvalidTransactionError,
  TransactionExecutionError,
} from 'near-api-js/rpc-errors';
import { z } from 'zod';
import type { Network } from './chains.js';
import { type RescueResult, rescueResultSchema } from './signature.js';

/** Spec section 3. */
export const MPC_CONTRACTS: Record<Network, string> = {
  mainnet: 'v1.signer',
  testnet: 'v1.signer-prod.testnet',
};

export const NEAR_RPC_URLS: Record<Network, string[]> = {
  mainnet: ['https://free.rpc.fastnear.com', 'https://archival-rpc.mainnet.fastnear.com'],
  testnet: ['https://test.rpc.fastnear.com', 'https://archival-rpc.testnet.fastnear.com'],
};

/** The most one call can attach. `sign` needs a share of it, and the rest is refunded. */
const DEFAULT_RESCUE_GAS_TGAS = 300;

/** The MPC contract yields for about 200 blocks before giving up on a signature. */
const DEFAULT_RESCUE_TIMEOUT_MS = 150_000;

const POLL_INTERVAL_MS = 1_000;
const NONCE_ATTEMPTS = 3;

/** Few and short, because the rescue has its own deadline and polls on top of this. */
const RESCUE_RPC_RETRIES = { retries: 3, wait: 250, backoff: 1.5 };

export interface RescueFees {
  nonce: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface RescueRequest {
  id: number;
  amount: bigint;
  fees: RescueFees;
}

export interface RescueOutcome {
  nearTx: string;
  /** Who signed the NEAR transaction. The RPC needs it to look the hash up. */
  nearSender: string;
  includedAtMs: number;
  signedAtMs: number;
  result: RescueResult;
}

/** The one call the keeper makes on NEAR. Tests replace it here. */
export interface NearRescuer {
  rescue(request: RescueRequest): Promise<RescueOutcome>;
}

export class NearRescueError extends Error {
  constructor(
    readonly reason: 'near_rejected' | 'near_failed' | 'near_bad_result' | 'near_timeout',
    message: string,
    /** Set once the transaction may have left, or null if a node refused it outright. */
    readonly nearTx: string | null,
    /** Who signed `nearTx`. The RPC needs it to look the hash up. */
    readonly nearSender: string | null,
  ) {
    super(message);
    this.name = 'NearRescueError';
  }
}

/** The argument shape of `rescue(id, amount, fees)` from spec section 4. */
export function rescueArgs({ id, amount, fees }: RescueRequest) {
  return {
    id,
    amount: amount.toString(),
    fees: {
      nonce: fees.nonce,
      max_fee_per_gas: fees.maxFeePerGas.toString(),
      max_priority_fee_per_gas: fees.maxPriorityFeePerGas.toString(),
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type TxResponse = Awaited<ReturnType<JsonRpcProvider['viewTransactionStatus']>>;

const failureOf = (status: unknown): string | null =>
  typeof status === 'object' && status !== null && 'Failure' in status
    ? JSON.stringify(status.Failure)
    : null;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A node answered and turned the transaction down, so it cannot still land. */
const refusedByNode = (error: unknown): boolean =>
  error instanceof TransactionExecutionError || error instanceof InvalidTransactionError;

export interface NearRescuerOptions {
  rpcUrl: string;
  contract: string;
  accountId: string;
  privateKey: string;
  gasTgas?: number;
  timeoutMs?: number;
  now?: () => number;
}

export function createNearRescuer(options: NearRescuerOptions): NearRescuer {
  const { rpcUrl, contract, accountId, privateKey } = options;
  const now = options.now ?? Date.now;
  const gas = teraToGas(options.gasTgas ?? DEFAULT_RESCUE_GAS_TGAS);
  const timeoutMs = options.timeoutMs ?? DEFAULT_RESCUE_TIMEOUT_MS;
  const provider = new JsonRpcProvider({ url: rpcUrl }, RESCUE_RPC_RETRIES);
  const newAccount = () => new Account(accountId, provider, privateKey as KeyPairString);
  let account = newAccount();

  /** Signs locally so the hash is known even if the answer to the send never arrives. */
  async function send(request: RescueRequest): Promise<string> {
    // A function-call access key cannot attach a deposit, so this is always zero.
    const action = actions.functionCall('rescue', rescueArgs(request), gas, 0n);
    for (let attempt = 1; ; attempt++) {
      const signer = account.getSigner();
      if (!signer) throw new Error('account has no signer');
      const publicKey = await signer.getPublicKey();
      const tx = await account.createTransaction({
        receiverId: contract,
        actions: [action],
        publicKey,
      });
      const { txHash, signedTransaction } = await signer.signTransaction(tx);
      const nearTx = base58.encode(txHash);
      try {
        await provider.sendTransactionUntil(signedTransaction, 'INCLUDED');
        return nearTx;
      } catch (error) {
        if (error instanceof InvalidNonceError && attempt < NONCE_ATTEMPTS) {
          // The nonce cache is private to Account, so a fresh one rereads the chain.
          account = newAccount();
          continue;
        }
        if (refusedByNode(error)) {
          throw new NearRescueError('near_rejected', messageOf(error), null, null);
        }
        // A timeout or a lost answer. It may have gone out, and polling will find out.
        return nearTx;
      }
    }
  }

  /**
   * The MPC signature can outlast one RPC wait, and the transaction is out of our hands
   * by now, so no error here means failure. Only the deadline does.
   */
  async function waitForExecution(nearTx: string, deadline: number): Promise<TxResponse> {
    let lastError = 'no answer';
    while (now() < deadline) {
      try {
        return await provider.viewTransactionStatus({
          txHash: nearTx,
          accountId,
          waitUntil: 'EXECUTED_OPTIMISTIC',
        });
      } catch (error) {
        lastError = messageOf(error);
        await sleep(POLL_INTERVAL_MS);
      }
    }
    throw new NearRescueError(
      'near_timeout',
      `no result within ${timeoutMs} ms: ${lastError}`,
      nearTx,
      accountId,
    );
  }

  return {
    async rescue(request) {
      const deadline = now() + timeoutMs;
      const nearTx = await send(request);
      const includedAtMs = now();
      const outcome = await waitForExecution(nearTx, deadline);

      const failure = failureOf(outcome.status);
      if (failure) throw new NearRescueError('near_failed', failure, nearTx, accountId);

      const parsed = rescueResultSchema.safeParse(getTransactionLastResult(outcome));
      if (!parsed.success) {
        throw new NearRescueError('near_bad_result', parsed.error.message, nearTx, accountId);
      }
      return { nearTx, nearSender: accountId, includedAtMs, signedAtMs: now(), result: parsed.data };
    },
  };
}

const bigintLike = z.union([z.string(), z.number()]).transform((value) => BigInt(value));

/** `get_position` from spec section 4. A u64 may arrive as a JSON number or a string. */
export const positionSchema = z.object({
  owner: z.string(),
  keeper: z.string(),
  chain_id: z.number().int(),
  borrower: z.string(),
  max_per_rescue: bigintLike,
  max_per_day: bigintLike,
  cooldown_secs: z.number().int().nonnegative(),
  paused: z.boolean(),
  spent_today: bigintLike,
  day: bigintLike,
  last_rescue_at: bigintLike,
});

export type Position = z.infer<typeof positionSchema>;

export interface NearViews {
  /** Caps as of `blockHash` when given, otherwise as of the final block. */
  getPosition(id: number, blockHash?: string): Promise<Position>;
  rootPublicKey(): Promise<string>;
  derivedPublicKey(path: string, predecessor: string): Promise<string>;
}

export function createNearViews(options: {
  rpcUrl: string;
  contract: string;
  mpc: string;
}): NearViews {
  const provider = new JsonRpcProvider({ url: options.rpcUrl });
  const viewString = async (method: string, args: Record<string, unknown>) =>
    z.string().parse(await provider.callFunction({ contractId: options.mpc, method, args }));

  return {
    async getPosition(id, blockHash) {
      const raw = await provider.callFunction({
        contractId: options.contract,
        method: 'get_position',
        args: { id },
        blockQuery: blockHash ? { blockId: blockHash } : { finality: 'final' },
      });
      return positionSchema.parse(raw);
    },
    rootPublicKey: () => viewString('public_key', { domain_id: 0 }),
    derivedPublicKey: (path, predecessor) =>
      viewString('derived_public_key', { path, predecessor, domain_id: 0 }),
  };
}

export interface NearTxStatus {
  /** The transaction and every receipt it spawned succeeded. */
  success: boolean;
  failure: string | null;
  signerId: string;
  receiverId: string;
  methodName: string | null;
  args: unknown;
  blockHash: string;
  returnValue: unknown;
}

function decodeArgs(encoded: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(base64.decode(encoded)));
  } catch {
    return null;
  }
}

/** Reduces an RPC outcome to the facts `verify` checks. */
export function summariseTransaction(outcome: TxResponse): NearTxStatus {
  const failures = [
    failureOf(outcome.status),
    ...outcome.receipts_outcome.map((receipt) => failureOf(receipt.outcome.status)),
  ].filter((failure) => failure !== null);

  const action = outcome.transaction.actions[0];
  const call =
    typeof action === 'object' && action !== null && 'FunctionCall' in action
      ? action.FunctionCall
      : null;

  return {
    success: failures.length === 0,
    failure: failures[0] ?? null,
    signerId: outcome.transaction.signer_id,
    receiverId: outcome.transaction.receiver_id,
    methodName: call?.method_name ?? null,
    args: call ? decodeArgs(call.args) : null,
    blockHash: outcome.transaction_outcome.block_hash,
    returnValue: getTransactionLastResult(outcome),
  };
}

/** Looks a transaction up with no keys. Archival endpoints go last in `rpcUrls`. */
export async function readNearTransaction(
  rpcUrls: string[],
  nearTx: string,
  sender: string,
): Promise<NearTxStatus> {
  const errors: string[] = [];
  for (const url of rpcUrls) {
    try {
      const provider = new JsonRpcProvider({ url }, { retries: 1, wait: 200, backoff: 1.5 });
      const outcome = await provider.viewTransactionStatus({
        txHash: nearTx,
        accountId: sender,
        waitUntil: 'FINAL',
      });
      return summariseTransaction(outcome);
    } catch (error) {
      errors.push(`${url}: ${error instanceof Error ? error.message : error}`);
    }
  }
  throw new Error(`could not resolve NEAR transaction ${nearTx}: ${errors.join('; ')}`);
}
