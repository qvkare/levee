/** Every outside link the site prints, in one place. Contract data is in contracts.ts. */
import { LEVEE_V2, UNWIND, baseAddressUrl, nearAccountUrl } from "./contracts.ts";

/** The Levee contract on NEAR testnet that repays from collateral. */
export const CONTRACT_ID = LEVEE_V2;

export const CONTRACT_URL = nearAccountUrl(CONTRACT_ID);

/** LeveeUnwind, the helper on Base Sepolia. */
export const UNWIND_URL = baseAddressUrl(UNWIND);

/** The source repository, linked from the footer and the /proof cards. */
export const GITHUB_URL: string = "https://github.com/qvkare/levee";
