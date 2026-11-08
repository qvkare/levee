import type { NextConfig } from "next";
import { readProof } from "./lib/proof-read.ts";

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // Pages rendered on the Worker cannot read the evidence or backtest folders, so every figure travels with the build.
  env: { LEVEE_PROOF: JSON.stringify(readProof()) },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default config;
