/**
 * A small time-boxed cache with in-flight sharing. Per process, so on serverless it only smooths
 * bursts. The API's Cache-Control header lets the CDN do the rest.
 */
export interface TtlCache<T> {
  get(key: string, load: () => Promise<T>): Promise<T>;
}

export function ttlCache<T>(ttlMs: (value: T) => number, maxEntries: number, now: () => number = Date.now): TtlCache<T> {
  const entries = new Map<string, { value: T; expires: number }>();
  const pending = new Map<string, Promise<T>>();

  return {
    get(key, load) {
      const hit = entries.get(key);
      if (hit && hit.expires > now()) return Promise.resolve(hit.value);
      entries.delete(key);

      const running = pending.get(key);
      if (running) return running;

      const task = load()
        .then((value) => {
          const ttl = ttlMs(value);
          if (ttl > 0) {
            entries.set(key, { value, expires: now() + ttl });
            // Maps keep insertion order, so the first key is the oldest.
            if (entries.size > maxEntries) entries.delete(entries.keys().next().value as string);
          }
          return value;
        })
        .finally(() => pending.delete(key));
      pending.set(key, task);
      return task;
    },
  };
}
