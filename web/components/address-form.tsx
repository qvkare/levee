"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent } from "react";
import { ADDRESS_ERRORS, shapeError } from "@/lib/address.ts";

/** A plain GET form that works without scripts. With scripts it validates in place and shows progress. */
export function AddressForm({ value = "", error = null }: { value?: string; error?: string | null }) {
  const router = useRouter();
  const id = useId();
  const [pending, startTransition] = useTransition();
  const [problem, setProblem] = useState(error);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const address = String(new FormData(event.currentTarget).get("address") ?? "").trim();
    const issue = shapeError(address);
    if (issue) {
      setProblem(ADDRESS_ERRORS[issue]);
      return;
    }
    setProblem(null);
    startTransition(() => router.push(`/a/${address}`));
  }

  return (
    <form className="address-form" action="/a" method="get" onSubmit={submit} noValidate>
      <label htmlFor={`${id}-address`}>Address</label>
      <div className="address-row">
        <input
          id={`${id}-address`}
          name="address"
          type="text"
          defaultValue={value}
          placeholder="0x…"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          aria-invalid={problem ? true : undefined}
          aria-describedby={`${id}-hint`}
        />
        <button className="button" type="submit" disabled={pending}>
          {pending ? "Reading" : "Read it"}
        </button>
      </div>
      <p id={`${id}-hint`} className={problem ? "form-error" : "form-hint"} role={problem ? "alert" : undefined}>
        {problem ?? "No wallet and no login. Reads Aave on Base and Arbitrum, and Hyperliquid."}
      </p>
    </form>
  );
}
