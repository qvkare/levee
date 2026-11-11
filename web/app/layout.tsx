import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import { SiteFooter } from "@/components/site-footer.tsx";
import { SiteHeader } from "@/components/site-header.tsx";
import "./globals.css";

const sans = localFont({
  src: "./fonts/overpass-latin-wght.woff2",
  weight: "100 900",
  variable: "--font-sans",
  display: "swap",
});

const mono = localFont({
  src: "./fonts/overpass-mono-latin-wght.woff2",
  weight: "300 700",
  variable: "--font-mono",
  display: "swap",
});

const DESCRIPTION = "When your Aave health factor falls below the trigger you set, Levee sells just enough of your own collateral to repay USDC debt back to your target. A NEAR contract with no keys signs it, and an ownerless helper checks the trigger and the price on chain. Live on testnet. Check any address, no wallet and no login.";

export const metadata: Metadata = {
  metadataBase: new URL("https://leveefi.xyz"),
  title: { default: "Levee", template: "%s | Levee" },
  description: DESCRIPTION,
  openGraph: { siteName: "Levee", title: "Levee", description: DESCRIPTION, type: "website" },
  twitter: { card: "summary_large_image", title: "Levee", description: DESCRIPTION },
};

// The browser chrome colour, which cannot read a CSS token.
export const viewport: Viewport = { themeColor: "#ffffff", colorScheme: "light" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <SiteHeader />
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
