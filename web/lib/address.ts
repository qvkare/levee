import { checksumAddress, type Address } from "viem";

export type AddressError = "empty" | "name" | "shape" | "checksum";

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Plain-language reasons. These reach the page and the API unchanged. */
export const ADDRESS_ERRORS: Record<AddressError, string> = {
  empty: "Paste an address first.",
  name: "Names are not resolved here. Paste the 0x address.",
  shape: "That is not an EVM address. It should be 0x followed by 40 hex characters.",
  checksum: "The capitals in this address do not match its checksum, so it may have a typo. Check it, or paste it in lowercase.",
};

/** Shape check only. It has no hashing, so the browser bundle stays small. */
export function shapeError(input: string): AddressError | null {
  const value = input.trim();
  if (!value) return "empty";
  if (!value.startsWith("0x") && value.includes(".")) return "name";
  return HEX_ADDRESS.test(value) ? null : "shape";
}

export type ParsedAddress = { ok: true; address: Address } | { ok: false; error: AddressError };

/**
 * Accepts lowercase, all-caps and correctly checksummed addresses, and returns EIP-55 form.
 * Mixed case with a wrong checksum is refused, because it usually means a typo.
 */
export function parseAddress(input: string): ParsedAddress {
  const value = input.trim();
  const error = shapeError(value);
  if (error) return { ok: false, error };
  const body = value.slice(2);
  const address = checksumAddress(`0x${body.toLowerCase()}`);
  const singleCase = body === body.toLowerCase() || body === body.toUpperCase();
  if (!singleCase && address !== value) return { ok: false, error: "checksum" };
  return { ok: true, address };
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
