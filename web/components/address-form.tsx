"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent } from "react";
import { ADDRESS_ERRORS, shapeError, shortAddress } from "@/lib/address.ts";

interface Props {
  /** The heading over the box. */
  title: string;
  /** One line under the heading. */
  lede?: string;
  /** What the box holds when the page opens: the address being read, or a refused input. */
  value?: string;
  /** Why the address in `value` was refused. */
  error?: string | null;
  /** A public address to try, linked under the box. */
  example?: { address: string; label: string };
  /** Told the moment a new read starts, so the page can set the old result aside. */
  onRead?: (address: string) => void;
  headingLevel?: 1 | 2;
}

/**
 * The address box. A plain GET form that works without scripts. With scripts it checks the shape in
 * place, says when it is reading, and opens the reading.
 */
export function AddressForm({ title, lede, value, error = null, example, onRead, headingLevel = 2 }: Props) {
  const router = useRouter();
  const id = useId();
  const [pending, startTransition] = useTransition();
  const [problem, setProblem] = useState(error);
  const Heading = headingLevel === 1 ? "h1" : "h2";

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const address = String(new FormData(event.currentTarget).get("address") ?? "").trim();
    const issue = shapeError(address);
    if (issue) {
      setProblem(ADDRESS_ERRORS[issue]);
      return;
    }
    setProblem(null);
    onRead?.(address);
    startTransition(() => router.push(`/a/${address}`));
  }

  return (
    <form className="plate" action="/a" method="get" role="search" aria-labelledby={`${id}-title`} onSubmit={submit} noValidate aria-busy={pending || undefined}>
      <Heading id={`${id}-title`}>{title}</Heading>
      {lede && <p>{lede}</p>}
      <label className="vh" htmlFor={`${id}-address`}>
        Wallet address
      </label>
      <div className="row">
        <input
          id={`${id}-address`}
          name="address"
          type="text"
          defaultValue={value}
          placeholder="Paste an address, 0x…"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? `${id}-note` : undefined}
        />
        <button type="submit" disabled={pending}>
          {pending ? "Reading" : "Read"}
        </button>
      </div>
      {problem && (
        <p id={`${id}-note`} className="ask-note" role="alert">
          {problem}
        </p>
      )}
      {example && (
        <p className="ex">
          <span className="ex-tag">Example</span>
          <Link href={`/a/${example.address}`} prefetch={false} className="mono" aria-label={`Read the example address ${example.address}`}>
            {shortAddress(example.address)}
          </Link>
          <span>{example.label}</span>
        </p>
      )}
    </form>
  );
}
