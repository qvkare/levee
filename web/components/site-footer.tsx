import Link from "next/link";
import { CONTRACT_URL, GITHUB_URL } from "@/lib/links.ts";
import { Brand } from "./site-header.tsx";

export function SiteFooter() {
  return (
    <footer className="site-foot">
      <Brand className="brand brand-plate" />
      <p>Levee is unaudited and its live runs are on testnet. Don’t use it with funds you can’t lose. This site reads public data, holds no funds and asks for no wallet. A NEAR hackathon entry.</p>
      <nav aria-label="Footer">
        <ul>
          <li>
            <a href={CONTRACT_URL} rel="noreferrer">
              Contract on NearBlocks
            </a>
          </li>
          {GITHUB_URL && (
            <li>
              <a href={GITHUB_URL} rel="noreferrer">
                Source on GitHub
              </a>
            </li>
          )}
          <li>
            <Link href="/how" prefetch={false}>
              How a rescue runs
            </Link>
          </li>
          <li>
            <Link href="/proof" prefetch={false}>
              Proof
            </Link>
          </li>
          <li>
            <Link href="/how#api" prefetch={false}>
              JSON API
            </Link>
          </li>
        </ul>
      </nav>
    </footer>
  );
}
