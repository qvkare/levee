/**
 * A small time-boxed cache of finished values. It holds per isolate, so it only smooths bursts.
 *
 * It stores values and not promises, on purpose. On Cloudflare Workers a promise belongs to the
 * request that created it. If a second request waited on it and the first client went away, the
 * second would hang. So concurrent misses each do their own read. Within one request, React's
 * cache() shares the read between the page and its metadata.
 */
export interface TtlCache<T> {
  get(key: string, load: () => Promise<T>): Promise<T>;
}

export function ttlCache<T>(ttlMs: (value: T) => number, maxEntries: number, now: () => number = Date.now): TtlCache<T> {
  const entries = new Map<string, { value: T; expires: number }>();

  return {
    async get(key, load) {
      const hit = entries.get(key);
      if (hit && hit.expires > now()) return hit.value;
      entries.delete(key);

      const value = await load();
      const ttl = ttlMs(value);
      if (ttl > 0) {
        entries.set(key, { value, expires: now() + ttl });
        // Maps keep insertion order, so the first key is the oldest.
        if (entries.size > maxEntries) entries.delete(entries.keys().next().value as string);
      }
      return value;
    },
  };
}
