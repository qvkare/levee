/**
 * The per-IP limit on reads. On Cloudflare this is the RISK_LIMIT binding from wrangler.jsonc, which
 * costs nothing on any plan. Everywhere else, and if the binding is missing, it is a counter in this
 * isolate. Each read makes about 25 upstream calls, so a burst from one address is worth stopping.
 */
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { fixedWindow } from "./limit.ts";

export const READS_PER_MINUTE = 30;

const local = fixedWindow(READS_PER_MINUTE, 60_000, 5000);

interface RateLimitBinding {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

export async function allowRead(key: string): Promise<boolean> {
  try {
    const { env } = getCloudflareContext();
    const binding = (env as unknown as { RISK_LIMIT?: RateLimitBinding }).RISK_LIMIT;
    if (binding) return (await binding.limit({ key })).success;
  } catch {
    // Outside a Worker there is no context. The local counter below takes over.
  }
  return local(key);
}
