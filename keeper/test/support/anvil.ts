/** Runs a local anvil fork of Base at the block the Foundry tests pin. */
import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { type Hex, createPublicClient, http, numberToHex } from 'viem';

/** Keep in step with Targets.base() in evm/test/lib/AaveFork.sol. */
export const FORK_BLOCK = 54_260_000n;
const DEFAULT_FORK_RPC = 'https://mainnet.base.org';

const STARTUP_TIMEOUT_MS = 120_000;

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });

export interface Anvil {
  url: string;
  stop(): void;
}

export async function startAnvil(): Promise<Anvil> {
  const port = await freePort();
  const forkUrl = process.env.BASE_FORK_RPC_URL || DEFAULT_FORK_RPC;
  const child: ChildProcess = spawn(
    'anvil',
    [
      '--fork-url',
      forkUrl,
      '--fork-block-number',
      FORK_BLOCK.toString(),
      '--port',
      String(port),
      // Blocks keep coming, so freshness checks see a live chain.
      '--block-time',
      '1',
      '--retries',
      '8',
      '--fork-retry-backoff',
      '1000',
      '--silent',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  const failedToStart = new Promise<never>((_, reject) => {
    child.once('error', (error) => reject(new Error(`could not start anvil: ${error.message}`)));
  });

  const url = `http://127.0.0.1:${port}`;
  const probe = createPublicClient({ transport: http(url, { retryCount: 0 }) });
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  const ready = (async () => {
    for (;;) {
      if (exited) throw new Error(`anvil exited during startup: ${stderr}`);
      if (Date.now() > deadline) throw new Error(`anvil did not start in time: ${stderr}`);
      try {
        await probe.getChainId();
        return;
      } catch {
        await delay(250);
      }
    }
  })();
  await Promise.race([ready, failedToStart]);

  return { url, stop: () => child.kill('SIGTERM') };
}

/**
 * Runtime code that returns `price` from any call. Anvil has no vm.mockCall, so the
 * WETH feed is replaced with this: PUSH32 price, PUSH1 0, MSTORE, PUSH1 32, PUSH1 0,
 * RETURN.
 */
export function constantPriceCode(price: bigint): Hex {
  const word = numberToHex(price, { size: 32 }).slice(2);
  return `0x7f${word}60005260206000f3`;
}
