"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/how", label: "How a rescue runs", short: "How it runs", page: "/how" },
  { href: "/how#who", label: "Who can do what", short: "Who can do what", page: null },
  { href: "/proof", label: "Proof", short: "Proof", page: "/proof" },
  { href: "/proof#backtest", label: "Backtest", short: "Backtest", page: null },
  { href: "/#read", label: "Read an address", short: "Read an address", page: null },
];

export function Brand({ className = "brand" }: { className?: string }) {
  return (
    <Link href="/" className={className} prefetch={false}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/levee-mark.svg" width={30} height={30} alt="" />
      Levee
    </Link>
  );
}

/** The header on every page: the mark, the pages, and what state Levee is in. */
export function SiteHeader() {
  const path = usePathname();
  return (
    <header className="site-head">
      <Brand />
      <nav className="site-nav" aria-label="Main">
        <ul>
          {LINKS.map((link) => (
            <li key={link.href}>
              <Link href={link.href} prefetch={false} aria-current={link.page !== null && path === link.page ? "page" : undefined}>
                <span className="wide">{link.label}</span>
                <span className="narrow">{link.short}</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <p className="status">Testnet</p>
    </header>
  );
}
