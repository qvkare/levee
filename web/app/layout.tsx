import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";

const text = localFont({
  src: "./fonts/schibsted-grotesk-latin-wght.woff2",
  weight: "400 900",
  variable: "--font-text",
  display: "swap",
});

const mono = localFont({
  src: "./fonts/atkinson-hyperlegible-mono-latin-wght.woff2",
  weight: "200 800",
  variable: "--font-mono",
  display: "swap",
});

const DESCRIPTION = "Every position at an address, in the order it would go. Levee repays your Aave debt from a reserve when your health factor crosses a trigger you set. No wallet and no login.";

export const metadata: Metadata = {
  metadataBase: new URL("https://levee.qvkare.com"),
  title: { default: "Levee", template: "%s | Levee" },
  description: DESCRIPTION,
  openGraph: { siteName: "Levee", title: "Levee", description: DESCRIPTION, type: "website" },
  twitter: { card: "summary_large_image", title: "Levee", description: DESCRIPTION },
};

export const viewport: Viewport = { themeColor: "#ffffff", colorScheme: "light" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${text.variable} ${mono.variable}`}>
      <body>
        <a className="skip" href="#main">
          Skip to content
        </a>
        {children}
        <footer className="foot">
          <p>Levee is unaudited. Do not use it with funds you cannot lose. Its live runs are on testnet. This site reads public data, holds no funds and asks for no wallet.</p>
          <nav aria-label="Footer">
            <Link href="/how" prefetch={false}>
              How a rescue runs
            </Link>
            <Link href="/how#limits" prefetch={false}>
              Limits
            </Link>
            <Link href="/proof" prefetch={false}>
              Proof
            </Link>
          </nav>
        </footer>
      </body>
    </html>
  );
}
