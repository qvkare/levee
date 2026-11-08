/** Every outside link the site prints, in one place. Contract data is in contracts.ts. */
import { LEVEE_V2, UNWIND, baseAddressUrl, nearAccountUrl } from "./contracts.ts";

/** The Levee contract on NEAR testnet that repays from collateral. */
export const CONTRACT_ID = LEVEE_V2;

export const CONTRACT_URL = nearAccountUrl(CONTRACT_ID);

/** LeveeUnwind, the helper on Base Sepolia. */
export const UNWIND_URL = baseAddressUrl(UNWIND);

/**
 * The source repository. It is private for now, so this is empty and nothing links to it. Set it
 * when the repository opens, and the footer and /proof pick it up.
 */
export const GITHUB_URL: string = "";
