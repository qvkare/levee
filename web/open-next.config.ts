import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import staticAssetsIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache";

/**
 * Prerendered pages are served from Workers static assets. This cache is read-only, so there is no
 * revalidation: `/`, `/how` and `/proof` change on deploy, and the home page refreshes its own
 * reading in the browser. It needs no KV or R2 binding.
 */
export default defineCloudflareConfig({
  incrementalCache: staticAssetsIncrementalCache,
  enableCacheInterception: true,
});
