import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";

/** Target of the address form when scripts are off. The result page does the validation. */
export function GET(request: NextRequest) {
  const address = request.nextUrl.searchParams.get("address")?.trim();
  redirect(address ? `/a/${encodeURIComponent(address)}` : "/");
}
