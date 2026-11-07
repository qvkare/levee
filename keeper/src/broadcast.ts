/** Sends a signed transaction everywhere and waits for it to land. */
import type { Hex } from 'viem';
import type { EvmClient, EvmReceipt } from './evm.js';

export interface BroadcastAttempt {
  rpc: string;
  ok: boolean;
  error: string | null;
}

/** The transaction reached this node some other way, which is what we wanted. */
const ALREADY_KNOWN = /already known|known transaction|already imported/i;

const errorText = (error: unknown): string => {
  const details = (error as { details?: string } | null)?.details;
  const short = (error as { shortMessage?: string } | null)?.shortMessage;
  return String(details ?? short ?? error);
};

/**
 * Sends to every endpoint in parallel, so one slow or censoring endpoint cannot hold
 * the rescue back. An endpoint reporting another hash is lying about the transaction
 * and is counted as a failure.
 */
export async function broadcastToAll(
  clients: EvmClient[],
  serialized: Hex,
  expectedHash: Hex,
): Promise<BroadcastAttempt[]> {
  return Promise.all(
    clients.map(async (client): Promise<BroadcastAttempt> => {
      try {
        const hash = await client.broadcast(serialized);
        if (hash.toLowerCase() !== expectedHash.toLowerCase()) {
          return { rpc: client.url, ok: false, error: `returned hash ${hash}` };
        }
        return { rpc: client.url, ok: true, error: null };
      } catch (error) {
        const text = errorText(error);
        return ALREADY_KNOWN.test(text)
          ? { rpc: client.url, ok: true, error: null }
          : { rpc: client.url, ok: false, error: text };
      }
    }),
  );
}

export interface ReceiptWait {
  timeoutMs: number;
  pollMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/** Polls every endpoint and returns the first receipt, or null at the deadline. */
export async function waitForReceipt(
  clients: EvmClient[],
  hash: Hex,
  wait: ReceiptWait,
): Promise<EvmReceipt | null> {
  const deadline = wait.now() + wait.timeoutMs;
  for (;;) {
    const reads = await Promise.allSettled(clients.map((client) => client.readReceipt(hash)));
    for (const read of reads) {
      if (read.status === 'fulfilled' && read.value) return read.value;
    }
    if (wait.now() >= deadline) return null;
    await wait.sleep(wait.pollMs);
  }
}
