/**
 * Renders app/opengraph-image.png, the link preview, in the Hat language: the four lanes, the route
 * of the replayed run and its time, all from the run records. Run it from web/ after the runs change:
 *
 *   node tools/og-image.ts            writes the page to the temp folder, and app/opengraph-image.alt.txt
 *   PLAYWRIGHT_CORE=/path/to/playwright-core node tools/og-image.ts
 *                                     also screenshots the HTML to app/opengraph-image.png
 *
 * Playwright is not a dependency of the site. Point PLAYWRIGHT_CORE at any install of playwright-core.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readProof } from "../lib/proof-read.ts";
import { ogAlt } from "../lib/og.ts";

const web = fileURLToPath(new URL("..", import.meta.url));
const proof = readProof();
const replay = proof.replay;
if (!replay) throw new Error("No landed run to draw.");

const font = (name: string) => readFileSync(`${web}app/fonts/${name}`).toString("base64");
const C = { P: "#1F4FD6", K: "#3F4A55", N: "#087F5B", M: "#6B3FD4", ink: "#121826", ink2: "#4B5563", amber: "#F2A100", tint: "#F0F2F4", tint2: "#E4E8EC" };

const t = { near: replay.marks.near / 1000, signed: replay.marks.signed / 1000, sent: replay.marks.sent / 1000, included: replay.marks.included / 1000 };
const TMIN = -1.4;
const TMAX = Math.max(Math.floor(t.included) + 1, t.included + 0.6);
const x0 = 250;
const x1 = 1140;
const gap = 54;
const y0 = 352;
const pps = (x1 - x0) / (TMAX - TMIN);
const X = (s: number) => x0 + (s - TMIN) * pps;
const Y = (lane: number) => y0 + lane * gap;
const step = gap / pps;
const route: Array<[number, number]> = [
  [TMIN, 0],
  [0, 0],
  [0, 1],
  [t.near - step, 1],
  [t.near, 2],
  [t.near + step, 3],
  [t.signed, 3],
  [t.signed, 1],
  [t.sent, 1],
  [t.sent + step, 0],
  [t.included, 0],
];
const colours = ["P", "K", "K", "K", "N", "M", "M", "K", "P", "P"] as const;
const lanes = [
  ["P", "Your position"],
  ["K", "Keeper"],
  ["N", "Levee contract"],
  ["M", "MPC network"],
] as const;

const segments = route
  .slice(0, -1)
  .map(([ta, la], index) => {
    const [tb, lb] = route[index + 1] as [number, number];
    const dots = index === 0 ? ' stroke-dasharray="0.1 18"' : "";
    return `<line x1="${X(ta)}" y1="${Y(la)}" x2="${X(tb)}" y2="${Y(lb)}" stroke="${C[colours[index] as keyof typeof C]}" stroke-width="12" stroke-linecap="round"${dots}/>`;
  })
  .join("");

const laneLines = lanes
  .map(([key, name], index) => {
    const y = Y(index);
    return `<line x1="${X(TMIN) - 10}" y1="${y}" x2="${x1 + 20}" y2="${y}" stroke="${C[key]}" stroke-opacity=".28" stroke-width="4" stroke-linecap="round"/>
    <rect x="40" y="${y - 15}" width="30" height="30" rx="8" fill="${C[key]}"/><text x="55" y="${y + 7}" text-anchor="middle" class="b" fill="#fff" font-size="17">${key}</text>
    <text x="82" y="${y + 6}" class="b" fill="${C.ink}" font-size="19">${name}</text>`;
  })
  .join("");

const station = (s: number, lane: number, fill = "#fff", r = 9) => `<circle cx="${X(s)}" cy="${Y(lane)}" r="${r}" fill="${fill}" stroke="${C.ink}" stroke-width="4"/>`;
// The helper is the terminus: an ink square on your position's lane.
const terminus = replay.mode === "collateral" ? `<rect x="${X(t.included) - 12}" y="${Y(0) - 12}" width="24" height="24" rx="4" fill="${C.ink}" stroke="${C.ink}" stroke-width="4"/>` : station(t.included, 0, C.P, 11);
const total = (replay.marks.included / 1000).toFixed(1);
const { overall } = proof.modes.collateral.timing;
const p50 = ((overall.p50Ms ?? 0) / 1000).toFixed(1);
const trigger = replay.trigger?.toFixed(2) ?? "";
const arrival = replay.sale?.sold ? `LeveeUnwind sold ${replay.sale.sold}` : `Repaid ${replay.amount}`;
const after = replay.chosen === "keyless" ? ", after the contract lost its last key" : "";

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:Overpass;src:url(data:font/woff2;base64,${font("overpass-latin-wght.woff2")}) format("woff2");font-weight:100 900}
@font-face{font-family:"Overpass Mono";src:url(data:font/woff2;base64,${font("overpass-mono-latin-wght.woff2")}) format("woff2");font-weight:300 700}
html,body{margin:0;width:1200px;height:630px;background:#fff;font-family:Overpass,sans-serif;color:${C.ink};font-feature-settings:"tnum" 1;-webkit-font-smoothing:antialiased}
svg text{font-family:Overpass,sans-serif}.b{font-weight:800}.m{font-family:"Overpass Mono",monospace}
</style></head><body>
<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <rect width="1200" height="630" fill="#fff"/>
  <rect y="268" width="1200" height="362" fill="${C.tint}"/>
  <g transform="translate(40 38) scale(0.72)"><polygon points="9,15 27,6 27,39.5 9,57.5" fill="${C.ink}"/><polygon points="28.7,41.2 56,41.2 56,49.7 35.8,59.2 10.7,59.2" fill="${C.ink}"/></g>
  <text x="92" y="76" class="b" font-size="32">Levee</text>
  <rect x="1056" y="44" width="104" height="40" rx="7" fill="#fff" stroke="${C.ink}" stroke-width="2.5"/>
  <text x="1108" y="71" text-anchor="middle" font-size="19" font-weight="700">Testnet</text>
  <text x="40" y="160" class="b" font-size="46" letter-spacing="-1.4">Below your trigger, Levee repays</text>
  <text x="40" y="214" class="b" font-size="46" letter-spacing="-1.4">your Aave debt from your collateral</text>
  <text x="1160" y="182" text-anchor="end" class="b" font-size="96" letter-spacing="-3">${p50} s</text>
  <text x="1160" y="214" text-anchor="end" font-size="17" font-weight="600" fill="${C.ink2}">detection to repay, median of</text>
  <text x="1160" y="236" text-anchor="end" font-size="17" font-weight="600" fill="${C.ink2}">${overall.samples} testnet rescues from collateral</text>
  <rect x="${X(TMIN)}" y="${Y(0) - 24}" width="${X(0) - X(TMIN)}" height="${Y(3) - Y(0) + 48}" rx="6" fill="${C.tint2}"/>
  ${laneLines}
  ${segments}
  ${station(0, 0, C.amber)}${station(t.near, 2)}${station(t.signed, 3)}${station(t.sent, 1)}${terminus}
  <rect x="${X(0) - 140}" y="282" width="132" height="46" rx="8" fill="${C.amber}"/>
  <text x="${X(0) - 128}" y="300" font-size="13" font-weight="700">Below trigger ${trigger}</text>
  <text x="${X(0) - 128}" y="321" class="b" font-size="20">HF ${replay.healthBefore.toFixed(2)}</text>
  <rect x="${X(t.signed) - 214}" y="${(Y(2) + Y(3)) / 2 - 22}" width="196" height="44" rx="8" fill="${C.M}"/>
  <text x="${X(t.signed) - 202}" y="${(Y(2) + Y(3)) / 2 - 3}" class="b" font-size="16" fill="#fff">Signed by MPC</text>
  <text x="${X(t.signed) - 202}" y="${(Y(2) + Y(3)) / 2 + 15}" class="m" font-size="14" font-weight="600" fill="#fff">took ${((replay.marks.signed - replay.marks.near) / 1000).toFixed(2)} s</text>
  <rect x="${X(t.included) - 258}" y="276" width="284" height="52" rx="8" fill="${replay.mode === "collateral" ? C.ink : C.P}"/>
  <text x="${X(t.included) - 244}" y="297" font-size="14" font-weight="700" fill="#fff">${arrival}</text>
  <text x="${X(t.included) - 244}" y="318" class="b" font-size="19" fill="#fff">Repaid ${replay.amount}, HF ${replay.healthAfter.toFixed(2)}</text>
  <text x="40" y="600" font-size="17" font-weight="600" fill="${C.ink2}">A real ${replay.chain} rescue at ${total} s${after} · signed by NEAR Chain Signatures · levee.qvkare.com</text>
</svg></body></html>`;

const file = `${tmpdir()}/levee-og-image.html`;
writeFileSync(file, html);
writeFileSync(`${web}app/opengraph-image.alt.txt`, ogAlt(proof));
console.log(`wrote ${file} and app/opengraph-image.alt.txt`);

/** The little of Playwright this script uses. */
interface Chromium {
  launch(): Promise<{
    newPage(options: { viewport: { width: number; height: number } }): Promise<{
      setContent(html: string): Promise<void>;
      evaluate(run: () => unknown): Promise<unknown>;
      screenshot(options: { path: string }): Promise<unknown>;
    }>;
    close(): Promise<void>;
  }>;
}

const core = process.env.PLAYWRIGHT_CORE;
if (core) {
  const require = createRequire(import.meta.url);
  const { chromium } = require(core) as { chromium: Chromium };
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.setContent(html);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${web}app/opengraph-image.png` });
  await browser.close();
  console.log("wrote app/opengraph-image.png");
}
