"use client";

import { usePathname, useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent } from "react";
import { ADDRESS_ERRORS, shapeError } from "@/lib/address.ts";

interface Props {
  /** The address already shown, as a placeholder. An empty box reads this one. */
  shown?: string;
  error?: string | null;
  value?: string;
}

function Form({ value, shown, error = null }: Props) {
  const router = useRouter();
  const id = useId();
  const [pending, startTransition] = useTransition();
  const [problem, setProblem] = useState(error);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const address = String(new FormData(event.currentTarget).get("address") ?? "").trim() || (shown ?? "");
    const issue = shapeError(address);
    if (issue) {
      setProblem(ADDRESS_ERRORS[issue]);
      return;
    }
    setProblem(null);
    startTransition(() => router.push(`/a/${address}`));
  }

  return (
    <form className="ask" action="/a" method="get" role="search" onSubmit={submit} noValidate>
      <label className="vh" htmlFor={`${id}-address`}>
        Address
      </label>
      <input
        id={`${id}-address`}
        name="address"
        type="text"
        defaultValue={value}
        placeholder={shown ?? "Paste any address, 0x…"}
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? `${id}-note` : undefined}
      />
      <button type="submit" disabled={pending}>
        {pending ? "Reading" : "Read it"}
      </button>
      {problem && (
        <p id={`${id}-note`} className="ask-note" role="alert">
          {problem}
        </p>
      )}
    </form>
  );
}

/**
 * A plain GET form that works without scripts. With scripts it checks the shape in place and shows
 * progress. It lives in the header row, so it takes the address from the path it is on.
 */
export function AddressForm({ value, shown, error }: Props) {
  const pathname = usePathname();
  const fromPath = pathname.startsWith("/a/") ? decodeURIComponent(pathname.slice(3)) : undefined;
  return <Form key={pathname} value={value ?? fromPath} shown={shown} error={error} />;
}
