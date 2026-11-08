/** The link preview's alt text, from the same figures the image draws. tools/og-image.ts writes both. */
import type { Proof } from "./proof-model.ts";

export function ogAlt(proof: Proof): string {
  const { overall } = proof.modes.collateral.timing;
  const p50 = ((overall.p50Ms ?? 0) / 1000).toFixed(1);
  const chain = proof.replay?.chain ?? "testnet";
  const after = proof.replay?.chosen === "keyless" ? ", made after the NEAR contract lost its last key," : "";
  return `Levee. Below your trigger, Levee repays your Aave debt from your own collateral. A real ${chain} rescue${after} drawn on four lines: your position, the keeper, the Levee contract on NEAR and the MPC network, ending at LeveeUnwind on Base. ${p50} s from detection to repay, the median of ${overall.samples} testnet rescues from collateral.\n`;
}
