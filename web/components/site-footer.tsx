import Link from "next/link";
import { CONTRACT_URL, GITHUB_URL, UNWIND_URL } from "@/lib/links.ts";
import { Brand } from "./site-header.tsx";

export function SiteFooter() {
  return (
    <footer className="site-foot">
      <Brand className="brand brand-plate" />
      <p>Levee repays Aave debt from the borrower’s own collateral. It runs on testnet only: nothing is deployed on any mainnet. This site reads public data, holds no funds and asks for no wallet. A NEAR hackathon entry.</p>
      <nav aria-label="Footer">
        <ul>
          <li>
            <a href={CONTRACT_URL} rel="noreferrer">
              Levee v0.2 on NearBlocks
            </a>
          </li>
          <li>
            <a href={UNWIND_URL} rel="noreferrer">
              LeveeUnwind on Basescan
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
