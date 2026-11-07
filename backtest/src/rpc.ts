// Minimal JSON-RPC client for free public endpoints: rotates endpoints, backs off on
// rate limits, and never sends a key. Only the fetch scripts import this file; the
// offline `pnpm backtest` run does not.

export interface RpcError extends Error {
  code?: number;
  /** True when retrying on the same request cannot help, such as a reverted call. */
  fatal?: boolean;
}

interface EndpointState {
  url: string;
  coolUntil: number;
  ok: number;
  fail: number;
}

const FATAL_MESSAGES = ['execution reverted', 'revert', 'invalid opcode', 'stack underflow', 'out of gas'];

// Providers word their log-range limits in many ways. A match means "ask for less".
const RANGE_MESSAGES = [
  'range',
  'too large',
  'too many',
  'limit',
  'exceed',
  'response size',
  'query returned more',
  'block range',
];

export class RangeTooLargeError extends Error {}

export class Rpc {
  private readonly endpoints: EndpointState[];
  private next = 0;

  constructor(
    urls: string[],
    private readonly opts: { timeoutMs?: number; maxAttempts?: number } = {},
  ) {
    if (urls.length === 0) throw new Error('no endpoints');
    this.endpoints = urls.map((url) => ({ url, coolUntil: 0, ok: 0, fail: 0 }));
  }

  stats(): Array<Pick<EndpointState, 'url' | 'ok' | 'fail'>> {
    return this.endpoints.map(({ url, ok, fail }) => ({ url, ok, fail }));
  }

  private pick(): EndpointState {
    const now = Date.now();
    for (let i = 0; i < this.endpoints.length; i++) {
      const candidate = this.endpoints[(this.next + i) % this.endpoints.length]!;
      if (candidate.coolUntil <= now) {
        this.next = (this.next + i + 1) % this.endpoints.length;
        return candidate;
      }
    }
    // All cooling: take the one that recovers first.
    return [...this.endpoints].sort((a, b) => a.coolUntil - b.coolUntil)[0]!;
  }

  async call<T = unknown>(method: string, params: unknown[]): Promise<T> {
    const maxAttempts = this.opts.maxAttempts ?? 14;
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const endpoint = this.pick();
      const wait = endpoint.coolUntil - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        const result = await this.post<T>(endpoint, method, params);
        endpoint.ok++;
        return result;
      } catch (err) {
        lastError = err;
        endpoint.fail++;
        const e = err as RpcError;
        if (e.fatal) throw err;
        if (err instanceof RangeTooLargeError) throw err;
        endpoint.coolUntil = Date.now() + Math.min(30_000, 400 * 2 ** Math.min(attempt, 6));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async post<T>(endpoint: EndpointState, method: string, params: unknown[]): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 30_000);
    try {
      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: controller.signal,
      });
      const text = await response.text();
      let body: { result?: T; error?: { code?: number; message?: string } };
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`${endpoint.url}: HTTP ${response.status}: ${text.slice(0, 160)}`);
      }
      if (body.error) {
        const message = body.error.message ?? JSON.stringify(body.error);
        const lower = message.toLowerCase();
        if (method === 'eth_getLogs' && RANGE_MESSAGES.some((m) => lower.includes(m)) && response.status !== 429) {
          throw new RangeTooLargeError(`${endpoint.url}: ${message}`);
        }
        const error: RpcError = new Error(`${endpoint.url}: ${message}`);
        if (body.error.code !== undefined) error.code = body.error.code;
        error.fatal = FATAL_MESSAGES.some((m) => lower.includes(m));
        throw error;
      }
      if (body.result === undefined) throw new Error(`${endpoint.url}: empty result, HTTP ${response.status}`);
      return body.result;
    } finally {
      clearTimeout(timer);
    }
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `worker` over `items` with at most `concurrency` in flight. */
export async function pool<T>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index]!, index);
    }
  });
  await Promise.all(runners);
}
