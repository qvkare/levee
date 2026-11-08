#!/usr/bin/env node
/**
 * design-check: flags the AI-default patterns, the retired vocabulary and the Hat rules in DESIGN.md
 * (sections "Type", "Copy" and "Banned"). It matches code and copy. It cannot judge a concept;
 * DESIGN.md does that. Zero dependencies, Node 18+.
 *
 *   node tools/design-check.mjs <dir-or-file> [more paths] [--json]
 *
 * Suppress a line-level finding only with a reason, on the same line or the line above:
 *   /* design-allow: loading shimmer, not decoration *\/
 * Exit code 1 when anything is found, so it can run in CI.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UI = [".tsx", ".jsx", ".html", ".vue", ".svelte", ".astro"];
const STYLE = [".css", ".scss", ".sass", ".less"];
const SCRIPT = [".ts", ".js", ".mjs", ".cjs"];
const DOCS = [".md", ".mdx"];
const DATA = [".json", ".yaml", ".yml", ".txt"];
const TEXT = [...UI, ...STYLE, ...SCRIPT, ...DOCS, ...DATA];

const SKIP_DIRS = new Set([
  "node_modules", ".next", ".next-build", ".open-next", ".wrangler", "dist", "build", "out", "target", ".git", "generated",
  "coverage", ".turbo", ".vercel", ".svelte-kit", "fonts", "cache", "broadcast",
]);
// Files that legitimately name the banned patterns, or are written by tools.
const SKIP_FILES = new Set(["DESIGN.md", "AGENTS.md", "design-check.mjs", "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb"]);

const FONTS = ["Inter", "Roboto", "Poppins", "Montserrat", "Open Sans", "Lato", "Space Grotesk", "DM Sans", "Manrope", "Plus Jakarta Sans", "Outfit", "Sora", "Nunito"];
const fontAlt = (f) => FONTS.map(f).join("|");
const PURPLE_HEX = ["6366f1", "4f46e5", "4338ca", "818cf8", "8b5cf6", "7c3aed", "6d28d9", "a78bfa", "a855f7", "9333ea", "c084fc", "d946ef", "6e56cf", "7c6cff", "8b7bff", "6d5bff"];

/** Line rules. Each matches one line of one kind of file. */
const RULES = [
  {
    id: "gradient",
    in: [...STYLE, ...UI],
    re: /\b(?:repeating-)?(?:linear|radial|conic)-gradient\(/,
    msg: "Gradient. Use solid named colours from the palette.",
  },
  {
    id: "gradient-utility",
    in: UI,
    re: /\bbg-gradient-to-|\bbg-linear-to-|\bfrom-(?:indigo|violet|purple|fuchsia|blue|cyan|pink|sky)-\d|\bvia-[a-z]+-\d/,
    msg: "Tailwind gradient utility.",
  },
  {
    id: "gradient-text",
    in: [...STYLE, ...UI],
    re: /background-clip:\s*text|\bbg-clip-text\b|-webkit-text-fill-color:\s*transparent/,
    msg: "Gradient or clipped text. One colour per headline.",
  },
  {
    id: "default-purple",
    in: [...STYLE, ...UI, ...SCRIPT],
    re: new RegExp(`\\b(?:indigo|violet|purple|fuchsia)-(?:50|[1-9]00|950)\\b|#(?:${PURPLE_HEX.join("|")})\\b`, "i"),
    msg: "Default indigo or violet. Use a colour with a role in the product palette.",
  },
  {
    id: "glow",
    in: [...STYLE, ...UI],
    re: /(?:box|text)-shadow:[^;]*?\b0(?:px)?\s+0(?:px)?\s+[1-9]\d+px|\bshadow-(?:indigo|violet|purple|fuchsia|cyan|blue|sky)-\d|\bdrop-shadow-\[0_0_/,
    msg: "Glow. Elevation only where depth carries meaning.",
  },
  {
    id: "glass",
    in: [...STYLE, ...UI],
    re: /backdrop-filter|\bbackdrop-blur\b/,
    msg: "Blur panel (glassmorphism). Use opaque surfaces.",
  },
  {
    id: "default-font",
    in: [...STYLE, ...UI, ...SCRIPT, ".json"],
    re: new RegExp(
      [
        `font-family:[^;]*\\b(?:${fontAlt((f) => f)})\\b`,
        `\\b(?:${fontAlt((f) => f.replaceAll(" ", "_"))})\\s*\\(`,
        `@fontsource(?:-variable)?/(?:${fontAlt((f) => f.toLowerCase().replaceAll(" ", "-"))})\\b`,
        `fonts\\.googleapis\\.com/css2?\\?family=(?:${fontAlt((f) => f.replaceAll(" ", "\\+"))})\\b`,
        `\\bfont-(?:inter|roboto|poppins|montserrat)\\b`,
      ].join("|"),
    ),
    msg: "Default typeface. The product's faces are Overpass and Overpass Mono, for the reason in DESIGN.md.",
  },
  {
    id: "em-dash",
    in: TEXT,
    re: /—/,
    msg: "Em dash. Use a full stop, comma, colon or parentheses.",
  },
  {
    id: "emoji",
    in: UI,
    re: /\p{Emoji_Presentation}|\p{Extended_Pictographic}️/u,
    msg: "Emoji in the interface. Use the product's badges or words.",
  },
  {
    id: "arrow",
    in: UI,
    re: /[→↗➜➔⟶↪]/,
    msg: "Arrow glyph welded to a link or label. Let the link text say where it goes.",
  },
  {
    id: "eyebrow",
    in: [...STYLE, ...UI],
    re: /\b(?:eyebrow|kicker|overline)\b|\buppercase\b[^"'`\n]*\btracking-(?:wide|wider|widest|\[)|\btracking-(?:wide|wider|widest|\[)[^"'`\n]*\buppercase\b|text-transform:\s*uppercase[^}\n]*letter-spacing:\s*0?\.(?:0[5-9]|[1-9])/,
    msg: "Tracked all-caps label over a heading (eyebrow).",
  },
  {
    id: "sequence",
    in: [...STYLE, ...UI],
    re: /decimal-leading-zero|>\s*0[1-9]\s*</,
    msg: "01/02/03 marker. Number only real sequences.",
  },
  {
    id: "scroll-motion",
    in: [...STYLE, ...UI, ...SCRIPT],
    re: /\bfade-?(?:in-?)?up\b|\bslide-?(?:in-?)?up\b|\bdata-aos\b|\bwhileInView\b|\banimate-(?:bounce|ping|pulse)\b/i,
    msg: "Default scroll or attention motion.",
  },
  {
    id: "count-up",
    in: [...UI, ...SCRIPT],
    re: /\bcount-?up\b|react-countup/i,
    msg: "Count-up statistic. Show the number.",
  },
  {
    id: "filler-copy",
    in: [...UI, ...DOCS],
    re: /\b(?:elevate your|empower(?:s|ing)?\b|unlock (?:the|your)\b|seamless(?:ly)?\b|supercharge|revolutioni[sz]e|game[- ]changer|cutting[- ]edge|next[- ]gen(?:eration)?\b|harness the power|effortless(?:ly)?\b|transform your|build faster|ship faster|in today's|world[- ]class|best[- ]in[- ]class|unleash|skyrocket|blazing|lightning[- ]fast|state[- ]of[- ]the[- ]art)/i,
    msg: "Copy that fits any product. Say what only this product does.",
  },
  {
    id: "placeholder",
    in: [...UI, ...DOCS, ...SCRIPT, ".json"],
    re: /lorem ipsum|\bjohn doe\b|\bjane doe\b|\bacme (?:inc|corp|co)\b/i,
    msg: "Placeholder content. Use real data or a clearly marked example.",
  },
  {
    id: "round-number",
    in: [...UI, ...DOCS],
    // A bare 10x is a real leverage on this site. Only the marketing use is banned.
    re: /(?<![\d.,$])\d{1,3}(?:,\d{3})+\+|(?<![\w.])\d+[kKmM]\+(?!\w)|\b10x\s+(?:faster|better|more|cheaper|safer|easier|returns?|growth|yield)\b|\b99\.9+%/i,
    msg: "Round or unsourced number. Use a live figure, or cite it with a date.",
  },
  {
    id: "overclaim",
    in: [...UI, ...SCRIPT, ...DOCS],
    re: /\bnever\b|\bguarantee[sd]?\b|\btrustless\b|\bwithin seconds\b/i,
    msg: "A claim no table on this site backs. Say what was measured, and where.",
  },
  {
    id: "retired-vocabulary",
    in: [...UI, ...SCRIPT, ...STYLE, ...DOCS],
    re: /\bflood|\bfreeboard\b|\bhydrograph|\bgauges?\b|\bstaff\b|\briver\b|\bwater\b|\b(?:action|watch) stage\b|\bcrest\b|\bdrill\b|\bBarlow\b|Old Standard|\bLentic\b|\bthe wall\b|\bpunto\b|Schibsted|Atkinson/i,
    msg: "Vocabulary or type from a retired design. The site speaks of the line, its stops and liquidation.",
  },
  {
    id: "italic",
    in: [...STYLE, ...UI],
    re: /font-style:\s*italic|\bitalic\b(?=[^"'`]*["'`])/,
    msg: "Italic type. The shipped Overpass is upright only, so the browser would fake it.",
  },
  {
    id: "literal-colour",
    in: UI,
    re: /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b(?![\w-])/,
    unless: /href=|\bid=|`\$\{/,
    msg: "A literal colour in a component. Colour comes from the tokens in app/globals.css, through a class.",
  },
  {
    id: "amber-token",
    in: [...STYLE, ...UI, ...SCRIPT],
    re: /#f2a100\b/i,
    unless: /^\s*--amber:/,
    msg: "Amber outside its token. It marks below the trigger, the last 5% and what is being re-measured, through var(--amber).",
  },
  {
    id: "literal-size",
    in: STYLE,
    re: /(?:^|[;{\s])font-size:[ \t]*(?![ \t]|var\(--t-|inherit\b|100%|1em\b)[^;]+/,
    msg: "A literal type size. Use a --t-* token from the scale in DESIGN.md.",
  },
  {
    id: "font-shorthand",
    in: STYLE,
    re: /(?:^|[;{\s])font:\s*(?!inherit\b)[^;]*\d+(?:px|rem|em)/,
    msg: "The font shorthand sets a size outside the scale. Use font-size with a --t-* token.",
  },
  {
    id: "inline-size",
    in: UI,
    re: /\bfontSize\s*[:=]|\bfont-size=|\bfont-size:/,
    msg: "A type size set in a component. Use a t-* class, which reads the scale.",
  },
  {
    id: "x-not-y",
    in: UI,
    re: /[a-z0-9%)],\s+not\s+(?!only\b)[a-z]/i,
    msg: "An \"X, not Y\" turn. Say the thing and stop.",
  },
];

/** Whole-file rules, for patterns that span lines. */
const FILE_RULES = [
  {
    id: "heading-stop",
    in: UI,
    re: /<h([1-6])\b[^>]*>((?:(?!<\/h\1>)[\s\S])*?)\.\s*<\/h\1>/g,
    msg: "A heading that ends in a full stop. Headings are names.",
  },
  {
    id: "heading-stop",
    in: UI,
    re: /\btitle=["']([^"']*?)\.["']/g,
    msg: "A title that ends in a full stop. Headings are names.",
  },
];

const ALLOW = /design-allow:\s*\S/;

function walk(path, out) {
  let st;
  try {
    st = statSync(path);
  } catch {
    console.error(`design-check: cannot read ${path}`);
    process.exitCode = 2;
    return;
  }
  if (st.isDirectory()) {
    if (SKIP_DIRS.has(basename(path))) return;
    for (const name of readdirSync(path)) walk(join(path, name), out);
  } else if (TEXT.includes(extname(path)) && !SKIP_FILES.has(basename(path)) && st.size < 1_000_000) {
    out.push(path);
  }
}

function scan(file) {
  const ext = extname(file);
  const text = readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  const found = [];
  const rules = RULES.filter((r) => r.in.includes(ext));
  lines.forEach((line, i) => {
    if (line.length > 2000) return; // minified or generated
    if (ALLOW.test(line) || (i > 0 && ALLOW.test(lines[i - 1]))) return;
    for (const r of rules) {
      if (r.unless?.test(line)) continue;
      const m = r.re.exec(line);
      if (m) found.push({ file, line: i + 1, col: m.index + 1, rule: r.id, msg: r.msg, text: line.trim().slice(0, 140) });
    }
  });
  for (const r of FILE_RULES.filter((rule) => rule.in.includes(ext))) {
    for (const m of text.matchAll(r.re)) {
      const before = text.slice(0, m.index);
      const line = before.split(/\r?\n/).length;
      if (ALLOW.test(lines[line - 1] ?? "") || ALLOW.test(lines[line - 2] ?? "")) continue;
      found.push({ file, line, col: 1, rule: r.id, msg: r.msg, text: m[0].replace(/\s+/g, " ").trim().slice(0, 140) });
    }
  }
  return found;
}

/** The size tokens a stylesheet defines, and every distinct value they take, media queries included. */
function sizeTokens(css) {
  const values = new Map();
  for (const m of css.matchAll(/--(t-[\w-]+)\s*:\s*([^;]+);/g)) {
    const set = values.get(m[1]) ?? new Set();
    set.add(m[2].trim());
    values.set(m[1], set);
  }
  return values;
}

/**
 * The type scale, against DESIGN.md: every distinct size the stylesheets define counts once. Fails
 * when there are more than the `max-type-sizes` marker allows, or when a used token is not defined.
 */
function typeScale(files) {
  const here = dirname(fileURLToPath(import.meta.url));
  const design = [resolve(process.cwd(), "DESIGN.md"), resolve(here, "../DESIGN.md")].find((path) => existsSync(path));
  if (!design) return [];
  const marker = /design-check:\s*max-type-sizes\s+(\d+)/.exec(readFileSync(design, "utf8"));
  if (!marker) return [{ file: design, line: 1, col: 1, rule: "type-scale", msg: "DESIGN.md has no max-type-sizes marker, so the scale cannot be checked.", text: "" }];
  const max = Number(marker[1]);
  const found = [];
  const defined = new Map();
  const styles = files.filter((file) => STYLE.includes(extname(file)));
  for (const file of styles) {
    for (const [token, values] of sizeTokens(readFileSync(file, "utf8"))) {
      const set = defined.get(token) ?? new Set();
      values.forEach((value) => set.add(value));
      defined.set(token, set);
    }
  }
  const sizes = [...defined.values()].reduce((total, set) => total + set.size, 0);
  if (sizes > max) {
    found.push({ file: styles[0] ?? design, line: 1, col: 1, rule: "type-scale", msg: `${sizes} type sizes defined, and DESIGN.md allows ${max}.`, text: [...defined.keys()].join(", ") });
  }
  for (const file of [...styles, ...files.filter((f) => UI.includes(extname(f)))]) {
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .forEach((line, i) => {
        for (const m of line.matchAll(/var\(--(t-[\w-]+)\)/g)) {
          if (!defined.has(m[1])) found.push({ file, line: i + 1, col: m.index + 1, rule: "type-scale", msg: `--${m[1]} is not a size on the scale.`, text: line.trim().slice(0, 140) });
        }
      });
  }
  return found;
}

const args = process.argv.slice(2);
const json = args.includes("--json");
const targets = args.filter((a) => !a.startsWith("--"));
if (!targets.length) targets.push(".");

const files = [];
for (const t of targets) walk(t, files);
const findings = [...files.flatMap(scan), ...typeScale(files)];

if (json) {
  console.log(JSON.stringify(findings, null, 2));
} else {
  for (const f of findings) {
    console.log(`${relative(process.cwd(), f.file)}:${f.line}:${f.col}  ${f.rule}  ${f.msg}\n    ${f.text}`);
  }
  const byRule = findings.reduce((m, f) => m.set(f.rule, (m.get(f.rule) ?? 0) + 1), new Map());
  const summary = [...byRule].map(([k, v]) => `${k} ${v}`).join(", ");
  console.log(
    findings.length
      ? `\n${findings.length} finding(s) in ${new Set(findings.map((f) => f.file)).size} of ${files.length} files: ${summary}`
      : `design-check: ${files.length} files clean`,
  );
}
if (findings.length) process.exitCode = 1;
