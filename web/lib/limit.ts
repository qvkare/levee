/**
 * A fixed-window counter per key. Pure, and it holds per isolate, so on its own it only slows a
 * burst. The Worker uses Cloudflare's rate limiting binding first: see rate-limit.ts.
 */
export type Limiter = (key: string) => boolean;

export function fixedWindow(limit: number, windowMs: number, maxKeys: number, now: () => number = Date.now): Limiter {
  const windows = new Map<string, { used: number; ends: number }>();

  return (key) => {
    const time = now();
    const current = windows.get(key);
    if (current && current.ends > time) {
      current.used += 1;
      return current.used <= limit;
    }
    windows.delete(key);
    windows.set(key, { used: 1, ends: time + windowMs });
    // Maps keep insertion order, so the first key is the one that has waited longest.
    if (windows.size > maxKeys) windows.delete(windows.keys().next().value as string);
    return true;
  };
}

/** Cloudflare sets this header itself, so a client cannot forge it there. */
export function clientKey(headers: { get(name: string): string | null }): string {
  return headers.get("cf-connecting-ip") ?? headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
}
