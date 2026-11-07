import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";

const text = localFont({
  src: [
    { path: "./fonts/barlow-latin-300-normal.woff2", weight: "300", style: "normal" },
    { path: "./fonts/barlow-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/barlow-latin-500-normal.woff2", weight: "500", style: "normal" },
  ],
  variable: "--font-text",
  display: "swap",
});

const figures = localFont({
  src: [
    { path: "./fonts/barlow-condensed-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/barlow-condensed-latin-500-normal.woff2", weight: "500", style: "normal" },
  ],
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

const DESCRIPTION = "Levee repays your Aave debt from a reserve when your health factor crosses a trigger you set. Paste any address to read how close it is to liquidation. No wallet and no login.";

export const metadata: Metadata = {
  metadataBase: new URL("https://levee.qvkare.com"),
  title: { default: "Levee", template: "%s | Levee" },
  description: DESCRIPTION,
  openGraph: { siteName: "Levee", title: "Levee", description: DESCRIPTION, type: "website" },
  twitter: { card: "summary_large_image", title: "Levee", description: DESCRIPTION },
};

export const viewport: Viewport = { themeColor: "#fcfdfc", colorScheme: "light" };

const SECTIONS = [
  { href: "/#try", label: "Try a position" },
  { href: "/#how", label: "How it runs" },
  { href: "/#keys", label: "Keys" },
  { href: "/#limits", label: "Limits" },
  { href: "/how", label: "Trust and failures" },
  { href: "/proof", label: "Proof" },
];

function Links() {
  return SECTIONS.map((section) => (
    <Link key={section.href} href={section.href} prefetch={false}>
      {section.label}
    </Link>
  ));
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${text.variable} ${figures.variable} ${water.variable}`}>
      <body>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <header className="site-bar wrap">
          <Link href="/" className="wordmark">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/levee-mark.svg" width={28} height={28} alt="" />
            Levee
          </Link>
          <nav className="site-nav" aria-label="Main">
            <Links />
          </nav>
          <details className="menu">
            <summary>Menu</summary>
            <nav aria-label="Main">
              <Links />
            </nav>
          </details>
        </header>
        <main id="main">{children}</main>
        <footer className="site-footer wrap">
          <p>Unaudited. Do not use with funds you cannot lose. This site reads public data. It holds no funds and asks for no wallet.</p>
        </footer>
      </body>
    </html>
  );
}
