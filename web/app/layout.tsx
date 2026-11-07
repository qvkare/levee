import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";

const text = localFont({
  src: [
    { path: "./fonts/barlow-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/barlow-latin-500-normal.woff2", weight: "500", style: "normal" },
  ],
  variable: "--font-text",
  display: "swap",
});

const figures = localFont({
  src: "./fonts/barlow-condensed-latin-500-normal.woff2",
  weight: "500",
  style: "normal",
  variable: "--font-figures",
  display: "swap",
});

const water = localFont({
  src: "./fonts/old-standard-tt-latin-400-italic.woff2",
  weight: "400",
  style: "italic",
  variable: "--font-water",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Levee", template: "%s | Levee" },
  description: "Levee repays your Aave debt from a reserve when your health factor crosses a trigger you set. Paste any address to read how close it is to liquidation. No wallet and no login.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fcfdfc" },
    { media: "(prefers-color-scheme: dark)", color: "#0d161b" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${text.variable} ${figures.variable} ${water.variable}`}>
      <body>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <header className="site-header wrap">
          <Link href="/" className="wordmark">
            Levee
          </Link>
          <nav className="site-nav" aria-label="Main">
            <Link href="/how">How it works</Link>
            <Link href="/proof">Proof</Link>
          </nav>
        </header>
        <main id="main">{children}</main>
        <footer className="site-footer wrap">
          <p>Unaudited. Do not use with funds you cannot lose. This site reads public data. It holds no funds and asks for no wallet.</p>
        </footer>
      </body>
    </html>
  );
}
