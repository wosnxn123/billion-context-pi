// Snapcompact archiving for billion-context-pi.
// Frame shapes, normalization, serialization and pagination ported from
// @oh-my-pi/snapcompact (MIT, Copyright (c) 2025 omp contributors); PNG
// encoding delegated to the same native renderer (@oh-my-pi/pi-natives).
// Discarded history is rendered into bitmap frames, persisted on disk and
// re-attached as image blocks so pruned detail stays readable.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { CoreMessage } from "acp-kernel";

// ============================================================================
// Native bindings (Bun hosts load the package entry; Node hosts require the
// platform .node directly because the package loader uses Bun-only APIs)
// ============================================================================

export interface SnapRenderOptions {
  size: number;
  font?: string;
  cellWidth?: number;
  cellHeight?: number;
  stretch?: boolean;
  variant?: string;
  lineRepeat?: number;
  columns?: number;
}

interface SnapNative {
  renderSnapcompactPng(text: string, options: SnapRenderOptions): Promise<string>;
  snapcompactSupportedChars(font: string, chars: string): string;
  __ompInstallTokioRuntime?: () => void;
}

const localRequire = createRequire(import.meta.url);

function loadNative(): SnapNative {
  const platformPkg = `pi-natives-${process.platform}-${process.arch}`;
  const scoped = `@oh-my-pi/${platformPkg}`;
  const meta = import.meta as { dirname?: string };
  if (typeof meta.dirname === "string") {
    try {
      return localRequire("@oh-my-pi/pi-natives") as SnapNative;
    } catch {
      // pi-natives' main is Bun-only TS and its exports map has no require
      // entry; fall through to the platform binary.
    }
  }
  // The platform binary is rarely hoisted beside us: bun installs it into a
  // hash-suffixed hidden dir (`.pi-natives-<plat>-<arch>-XXXX`) under some
  // node_modules/@oh-my-pi. Walk up from this file and probe every scope dir
  // on the way: normal resolution first, then exact/hidden-dir scan loading
  // the .node main directly.
  let dir: string | undefined = meta.dirname ?? dirname(new URL(import.meta.url).pathname);
  let lastError: unknown;
  while (dir) {
    const scope = join(dir, "node_modules", "@oh-my-pi");
    if (existsSync(scope)) {
      try {
        const bindings = createRequire(join(dir, "probe.js"))(scoped) as SnapNative;
        bindings.__ompInstallTokioRuntime?.();
        return bindings;
      } catch (e) {
        lastError = e;
      }
      let entries: string[] = [];
      try {
        entries = readdirSync(scope);
      } catch {
        entries = [];
      }
      const match = entries.find((e) => e === platformPkg) ?? entries.find((e) => e.startsWith(`.${platformPkg}`));
      if (match) {
        try {
          const pkgDir = join(scope, match);
          const main = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).main as string | undefined;
          if (main) {
            const bindings = createRequire(join(pkgDir, "probe.js"))(main.startsWith(".") ? join(pkgDir, main) : main) as SnapNative;
            bindings.__ompInstallTokioRuntime?.();
            return bindings;
          }
        } catch (e) {
          lastError = e;
        }
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw lastError instanceof Error ? lastError : new Error(`Cannot load ${scoped} (no hoisted or bun-isolated copy found)`);
}

let native: SnapNative | undefined;
function getNative(): SnapNative {
  native ??= loadNative();
  return native;
}

// ============================================================================
// Shapes (ported)
// ============================================================================

export interface Shape {
  font: "5x8" | "8x8" | "6x12" | "8x13" | "silver";
  cellWidth: number;
  cellHeight: number;
  stretch?: boolean;
  variant: "sent" | "bw";
  stopwordDim?: boolean;
  columns?: number;
  lineRepeat: number;
  frameSize: number;
  frameTokenEstimate: number;
  imageDetail?: "auto" | "low" | "high" | "original";
}

type ShapeGeometry = Omit<Shape, "frameTokenEstimate" | "imageDetail">;

export const SHAPE_VARIANTS = {
  "8x8r-bw": { font: "8x8", cellWidth: 8, cellHeight: 8, variant: "bw", lineRepeat: 2, frameSize: 1568 },
  "8x8r-sent": { font: "8x8", cellWidth: 8, cellHeight: 8, variant: "sent", lineRepeat: 2, frameSize: 1568 },
  "8x8u-bw": { font: "8x8", cellWidth: 8, cellHeight: 8, variant: "bw", lineRepeat: 1, frameSize: 1568 },
  "8x8u-sent": { font: "8x8", cellWidth: 8, cellHeight: 8, variant: "sent", lineRepeat: 1, frameSize: 1568 },
  "6x6u-bw": { font: "8x8", cellWidth: 6, cellHeight: 6, variant: "bw", lineRepeat: 1, frameSize: 1568 },
  "6x6u-sent": { font: "8x8", cellWidth: 6, cellHeight: 6, variant: "sent", lineRepeat: 1, frameSize: 1568 },
  "5x8-bw": { font: "5x8", cellWidth: 5, cellHeight: 8, variant: "bw", lineRepeat: 1, frameSize: 2576 },
  "5x8-sent": { font: "5x8", cellWidth: 5, cellHeight: 8, variant: "sent", lineRepeat: 1, frameSize: 2576 },
  "6x12-dim": { font: "6x12", cellWidth: 6, cellHeight: 12, variant: "bw", stopwordDim: true, lineRepeat: 1, frameSize: 1568 },
  "8x13-bw": { font: "8x13", cellWidth: 8, cellHeight: 13, variant: "bw", lineRepeat: 1, frameSize: 1568 },
  "8on16-bw": { font: "8x13", cellWidth: 8, cellHeight: 16, stretch: false, variant: "bw", lineRepeat: 1, frameSize: 1568 },
  "8on22-bw": { font: "8x13", cellWidth: 8, cellHeight: 22, stretch: false, variant: "bw", lineRepeat: 1, frameSize: 1568 },
  "11on16-bw": { font: "8x13", cellWidth: 11, cellHeight: 16, stretch: false, variant: "bw", lineRepeat: 1, frameSize: 1568 },
  "silver16-bw": { font: "silver", cellWidth: 16, cellHeight: 16, variant: "bw", lineRepeat: 1, frameSize: 1568 },
  "doc-8on16-bw": { font: "8x13", cellWidth: 8, cellHeight: 16, stretch: false, variant: "bw", columns: 2, lineRepeat: 1, frameSize: 1568 },
  "doc-8on16-sent": { font: "8x13", cellWidth: 8, cellHeight: 16, stretch: false, variant: "sent", columns: 2, lineRepeat: 1, frameSize: 1568 },
  "doc-8on16-sent-dim": { font: "8x13", cellWidth: 8, cellHeight: 16, stretch: false, variant: "sent", stopwordDim: true, columns: 2, lineRepeat: 1, frameSize: 1568 },
} as const satisfies Record<string, ShapeGeometry>;

export type ShapeVariantName = keyof typeof SHAPE_VARIANTS;

export function isShapeVariantName(value: unknown): value is ShapeVariantName {
  return typeof value === "string" && value in SHAPE_VARIANTS;
}

type BillingFamily = "anthropic" | "google" | "openai" | "unknown";

function billingFamily(api?: string): BillingFamily {
  switch (api) {
    case "anthropic-messages":
    case "bedrock-converse-stream":
      return "anthropic";
    case "openai-completions":
    case "openai-responses":
    case "openai-codex-responses":
    case "azure-openai-responses":
      return "openai";
    case "google-generative-ai":
    case "google-gemini-cli":
    case "google-vertex":
      return "google";
    default:
      return "unknown";
  }
}

function familyBilling(family: BillingFamily, frameSize: number): Pick<Shape, "frameTokenEstimate" | "imageDetail"> {
  switch (family) {
    case "google":
      return { frameTokenEstimate: 1120 };
    case "openai": {
      const patches = Math.min(Math.ceil(frameSize / 32) ** 2, 10_000);
      return { frameTokenEstimate: Math.ceil(patches * 1.2), imageDetail: "original" };
    }
    default: {
      const patches = Math.min(Math.ceil(frameSize / 28) ** 2, 4784);
      return { frameTokenEstimate: Math.ceil(patches * 1.05) };
    }
  }
}

function priceShape(base: ShapeGeometry, family: BillingFamily): Shape {
  return { ...base, ...familyBilling(family, base.frameSize) };
}

const MODEL_VARIANTS: readonly (readonly [RegExp, { variant: ShapeVariantName; frameSize?: number }])[] = [
  [/claude.*(fable|mythos)/i, { variant: "11on16-bw", frameSize: 1932 }],
  [/claude-?opus-?4[.-][7-9]/i, { variant: "11on16-bw", frameSize: 1932 }],
  [/claude/i, { variant: "11on16-bw" }],
  [/gemini/i, { variant: "8on22-bw", frameSize: 2048 }],
  [/gpt|codex/i, { variant: "8on22-bw" }],
  [/kimi/i, { variant: "8on22-bw" }],
  [/glm/i, { variant: "8on16-bw" }],
];


/** What will read the frames: the wire API (billing) and model id (shape). */
export interface ShapeTarget {
  api?: string;
  id?: string;
}

const FAMILY_VARIANT: Record<BillingFamily, ShapeVariantName> = {
  anthropic: "11on16-bw",
  google: "8on22-bw",
  openai: "8on22-bw",
  unknown: "8on22-bw",
};
const FAMILY_SHAPE: Record<BillingFamily, Shape> = {
  anthropic: priceShape(SHAPE_VARIANTS["11on16-bw"], "anthropic"),
  google: priceShape(SHAPE_VARIANTS["8on22-bw"], "google"),
  openai: priceShape(SHAPE_VARIANTS["8on22-bw"], "openai"),
  unknown: priceShape(SHAPE_VARIANTS["8on22-bw"], "unknown"),
};

export function resolveShape(model?: ShapeTarget, variant?: ShapeVariantName | "auto"): Shape {
  const family = billingFamily(model?.api);
  if (variant && variant !== "auto") return priceShape(SHAPE_VARIANTS[variant], family);
  const modelId = model?.id;
  const ideal = modelId ? MODEL_VARIANTS.find(([pattern]) => pattern.test(modelId))?.[1] : undefined;
  const name = ideal?.variant ?? FAMILY_VARIANT[family];
  if (name === FAMILY_VARIANT[family] && ideal?.frameSize === undefined) return FAMILY_SHAPE[family];
  const base = SHAPE_VARIANTS[name];
  return priceShape(ideal?.frameSize ? { ...base, frameSize: ideal.frameSize } : base, family);
}

// Conservative per-frame budgeting upper bound (high-res Claude cap + 5%).
export const FRAME_TOKEN_ESTIMATE = 5024;

// ============================================================================
// Normalization (ported)
// ============================================================================

export const DIM_ON = "\u000e";
export const DIM_OFF = "\u000f";
const DIM_MARKERS = /[\u000e\u000f]/g;

/** Printed in place of newline runs: the native renderer fills this cell black. */
export const NEWLINE_GLYPH = "\u2588";

const COLLAPSIBLE = /[\s\p{Cf}]+/gu;
const LINE_BREAK = /[\n\r\u2028\u2029]/;
const EDGE_RUNS = /^[ \u2588]+|[ \u2588]+$/g;
const UNRENDERABLE = /[\p{Cc}\p{Mn}\p{Me}\p{Cs}]/u;
const COMBINING_MARKS = /\p{M}+/gu;
const EMOJI_PICTOGRAPH = /\p{Extended_Pictographic}/u;

const CHAR_FOLD: Record<string, string> = {
  "\u2018": "'", "\u2019": "'", "\u201a": "'", "\u201b": "'",
  "\u201c": '"', "\u201d": '"', "\u201e": '"',
  "\u2032": "'", "\u2033": '"', "\u2035": "'", "\u2036": '"',
  "\u2039": "<", "\u203a": ">",
  "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2013": "-", "\u2014": "-", "\u2015": "-", "\u2212": "-", "\u2044": "/",
  "\u2024": ".", "\u2025": "..", "\u2026": "...", "\u22ef": "...",
  "\u2022": "*", "\u2023": "*", "\u2043": "-", "\u2219": "*", "\u25cf": "*", "\u25a0": "*", "\u25aa": "*",
  "\u2190": "<-", "\u2191": "^", "\u2192": "->", "\u2193": "v", "\u2194": "<->",
  "\u21d0": "<=", "\u21d2": "=>", "\u21d4": "<=>",
  "\u2713": "v", "\u2714": "v", "\u2717": "x", "\u2718": "x",
};

const EMOJI_FOLD: Record<string, string> = {
  "\u2705": "[OK]", "\u2611": "[OK]", "\u2714": "[OK]",
  "\u274c": "[FAIL]", "\u274e": "[FAIL]", "\u2716": "[FAIL]",
  "\u26a0": "[WARN]", "\ud83d\udea8": "[ALERT]", "\u2139": "[INFO]",
  "\ud83d\udc1b": "[BUG]", "\ud83d\udca5": "[CRASH]", "\ud83d\udd25": "[HOT]",
  "\ud83d\udd12": "[LOCK]", "\ud83d\udd13": "[UNLOCK]",
  "\ud83d\udcc1": "[DIR]", "\ud83d\udcc2": "[DIR]", "\ud83d\udcc4": "[FILE]",
  "\ud83d\udcdd": "[NOTE]", "\ud83e\uddea": "[TEST]",
  "\u23f3": "[WAIT]", "\u231b": "[WAIT]", "\ud83d\ude80": "[RUN]",
};

// Bun ships stripANSI; Node hosts strip CSI/OSC/control escapes here instead.
const ANSI_ESCAPE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x1b\\|\x07)|\x1b[@-Z\\-_]/g;

function stripDimMarkers(text: string): string {
  return text.replace(DIM_MARKERS, "");
}

function isAsciiOrLatin1(cp: number): boolean {
  return (cp >= 0x20 && cp < 0x7f) || (cp >= 0xa0 && cp <= 0xff);
}

function foldToAscii(ch: string): string | undefined {
  const decomposed = ch.normalize("NFKD").replace(COMBINING_MARKS, "");
  if (decomposed === ch) return undefined;
  let out = "";
  for (const part of decomposed) {
    const cp = part.codePointAt(0);
    if (cp !== undefined && isAsciiOrLatin1(cp)) {
      out += part;
      continue;
    }
    const fold = CHAR_FOLD[part];
    if (fold === undefined) return undefined;
    out += fold;
  }
  return out;
}

function renderableUnicodeChars(chars: readonly string[], font: Shape["font"] | undefined): ReadonlySet<string> {
  if (chars.length === 0) return new Set();
  const text = chars.join("");
  const primaryFont = font ?? "5x8";
  const supported = new Set(getNative().snapcompactSupportedChars(primaryFont, text));
  if (primaryFont !== "silver") {
    for (const ch of getNative().snapcompactSupportedChars("silver", text)) supported.add(ch);
  }
  return supported;
}

function normalizedInputChars(text: string): string[] {
  const stripped = text.includes("\u001b") ? text.replace(ANSI_ESCAPE, "") : text;
  const collapsed = stripped
    .replace(COLLAPSIBLE, run => (LINE_BREAK.test(run) ? NEWLINE_GLYPH : /[^\p{Cf}]/u.test(run) ? " " : ""))
    .replace(EDGE_RUNS, "");
  return [...collapsed];
}

function candidateUnicodeChars(chars: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const ch of chars) {
    const cp = ch.codePointAt(0);
    if (cp === undefined || isAsciiOrLatin1(cp) || ch === DIM_ON || ch === DIM_OFF || ch === NEWLINE_GLYPH) continue;
    if (
      CHAR_FOLD[ch] !== undefined ||
      (cp >= 0x2500 && cp <= 0x257f) ||
      EMOJI_FOLD[ch] !== undefined ||
      EMOJI_PICTOGRAPH.test(ch) ||
      foldToAscii(ch) !== undefined ||
      UNRENDERABLE.test(ch)
    ) {
      continue;
    }
    unique.add(ch);
  }
  return [...unique];
}

function normalizeWithStats(text: string, shape?: Pick<Shape, "font">): { text: string; totalGraphics: number; fallbackCount: number } {
  const chars = normalizedInputChars(text);
  const font = shape?.font;
  const supported = renderableUnicodeChars(candidateUnicodeChars(chars), font);
  const out: string[] = [];
  let totalGraphics = 0;
  let fallbackCount = 0;
  for (const ch of chars) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (isAsciiOrLatin1(cp)) {
      out.push(ch);
      totalGraphics++;
      continue;
    }
    if (ch === DIM_ON || ch === DIM_OFF || ch === NEWLINE_GLYPH) {
      out.push(ch);
      continue;
    }
    const emoji = EMOJI_FOLD[ch];
    if (emoji !== undefined) {
      out.push(emoji);
      totalGraphics++;
      continue;
    }
    const fold = CHAR_FOLD[ch];
    if (fold !== undefined) {
      out.push(fold);
      totalGraphics++;
      continue;
    }
    if (cp >= 0x2500 && cp <= 0x257f) {
      out.push(cp === 0x2502 || cp === 0x2503 ? "|" : cp === 0x2500 || cp === 0x2501 ? "-" : "+");
      totalGraphics++;
      continue;
    }
    if (!EMOJI_PICTOGRAPH.test(ch) && supported.has(ch)) {
      out.push(ch);
      totalGraphics++;
      continue;
    }
    const folded = foldToAscii(ch);
    if (folded !== undefined) {
      out.push(folded);
      totalGraphics++;
    } else if (!EMOJI_PICTOGRAPH.test(ch) && !UNRENDERABLE.test(ch)) {
      out.push("?");
      totalGraphics++;
      fallbackCount++;
    }
  }
  return { text: out.join("").replace(/ +/g, " ").replace(EDGE_RUNS, ""), totalGraphics, fallbackCount };
}

export function normalize(text: string, shape?: Pick<Shape, "font">): string {
  return normalizeWithStats(text, shape).text;
}

/** Unsafe = more than 5% of graphic characters would hit the `?` fallback. */
export function scanRenderability(text: string, shape?: Pick<Shape, "font">): { isSafe: boolean; unrenderableRatio: number } {
  const normalized = normalizeWithStats(text, shape);
  const unrenderableRatio = normalized.totalGraphics > 0 ? normalized.fallbackCount / normalized.totalGraphics : 0;
  return { isSafe: unrenderableRatio <= 0.05, unrenderableRatio };
}

const CJK_HEAVY_MIN_WIDE_CHARS = 8;
const CJK_HEAVY_WIDE_RATIO = 0.25;

function isCjkHeavyText(text: string): boolean {
  const chars = normalizedInputChars(text);
  let graphicChars = 0;
  let wideChars = 0;
  for (const ch of chars) {
    if (ch === " " || ch === DIM_ON || ch === DIM_OFF || ch === NEWLINE_GLYPH) continue;
    const cp = ch.codePointAt(0);
    if (cp === undefined || UNRENDERABLE.test(ch)) continue;
    graphicChars++;
    if (isWideCodePoint(cp)) wideChars++;
  }
  return wideChars >= CJK_HEAVY_MIN_WIDE_CHARS && wideChars / graphicChars >= CJK_HEAVY_WIDE_RATIO;
}

export function resolveShapeForText(text: string, model?: ShapeTarget, variant?: ShapeVariantName | "auto"): Shape {
  const shape = resolveShape(model, variant);
  if (variant && variant !== "auto") return shape;
  const silver = resolveShape(model, "silver16-bw");
  if (!scanRenderability(text, shape).isSafe) {
    return scanRenderability(text, silver).isSafe ? silver : shape;
  }
  return shape.font !== "silver" && isCjkHeavyText(text) && scanRenderability(text, silver).isSafe ? silver : shape;
}

// ============================================================================
// Stopword dimming (ported)
// ============================================================================

const STOPWORDS: Record<string, true> = {
  the: true, a: true, an: true, and: true, or: true, of: true, to: true, in: true, on: true, at: true, as: true,
  is: true, are: true, was: true, were: true, be: true, been: true, by: true, for: true, with: true, that: true,
  this: true, it: true, its: true, from: true, had: true, has: true, have: true, not: true, but: true,
  he: true, she: true, his: true, her: true, they: true, their: true, them: true, which: true, also: true,
  who: true, whom: true, when: true, where: true, while: true, will: true, would: true, could: true, should: true,
  there: true, then: true, than: true, into: true, over: true, under: true, about: true, after: true,
  before: true, between: true, during: true, each: true, such: true, these: true, those: true, some: true,
  most: true, more: true, other: true, only: true, same: true, so: true,
};

const ALPHA_RUN = /[a-zA-Z\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u00ff]+/g;
const DIM_MARKER_SPLIT = /([\u000e\u000f])/;

export function dimStopwords(text: string): string {
  const parts = text.split(DIM_MARKER_SPLIT);
  let dim = false;
  let out = "";
  for (const part of parts) {
    if (part === DIM_ON) {
      dim = true;
      out += part;
    } else if (part === DIM_OFF) {
      dim = false;
      out += part;
    } else if (dim) {
      out += part;
    } else {
      out += part.replace(ALPHA_RUN, word => (word.toLowerCase() in STOPWORDS ? DIM_ON + word + DIM_OFF : word));
    }
  }
  return out;
}

// ============================================================================
// Geometry and pagination (ported)
// ============================================================================

const DOC_GUTTER = 3;

// Mirrors `is_wide` in crates/pi-natives/src/snapcompact.rs; keep in sync.
function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x2eff) ||
    (cp >= 0x2f00 && cp <= 0x2fdf) ||
    (cp >= 0x3000 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x2fffd) ||
    (cp >= 0x30000 && cp <= 0x3fffd)
  );
}

function charCells(ch: string, wideCells: boolean): number {
  if (ch === DIM_ON || ch === DIM_OFF) return 0;
  const cp = ch.codePointAt(0);
  return wideCells && cp !== undefined && isWideCodePoint(cp) ? 2 : 1;
}

function usesWideCells(shape: Pick<Shape, "font">): boolean {
  return shape.font !== "silver";
}

function sliceCells(text: string, width: number, wideCells: boolean): string {
  let cells = 0;
  let out = "";
  let placed = false;
  for (const ch of text) {
    const w = charCells(ch, wideCells);
    if (placed && cells + w > width) break;
    out += ch;
    cells += w;
    if (w > 0) placed = true;
  }
  return out;
}

function paginateCells(text: string, capacity: number, cols: number, wideCells: boolean): string[] {
  const chars = [...text];
  const pages: string[] = [];
  let start = 0;
  let cell = 0;
  let hasCell = false;
  for (let i = 0; i < chars.length; i++) {
    const w = charCells(chars[i] ?? "", wideCells);
    if (w === 0) continue;
    let at = cell;
    if (w === 2 && cols >= 2 && at % cols === cols - 1) at += 1;
    if (hasCell && at + w > capacity) {
      pages.push(chars.slice(start, i).join(""));
      start = i;
      at = 0;
    }
    cell = at + w;
    hasCell = true;
  }
  if (hasCell) pages.push(chars.slice(start).join(""));
  return pages;
}

function wrap(text: string, width: number, wideCells: boolean): string[] {
  const cellLength = (s: string): number => {
    let cells = 0;
    for (const ch of s) cells += charCells(ch, wideCells);
    return cells;
  };
  const lines: string[] = [];
  let cur = "";
  let curCells = 0;
  for (const token of text.split(/\s+/)) {
    if (token.length === 0) continue;
    let word = token;
    let wordCells = cellLength(word);
    while (wordCells > width) {
      if (cur) {
        lines.push(cur);
        cur = "";
        curCells = 0;
      }
      const head = sliceCells(word, width, wideCells);
      lines.push(head);
      word = word.slice(head.length);
      wordCells = cellLength(word);
    }
    if (!cur) {
      cur = word;
      curCells = wordCells;
    } else if (curCells + 1 + wordCells <= width) {
      cur += ` ${word}`;
      curCells += 1 + wordCells;
    } else {
      lines.push(cur);
      cur = word;
      curCells = wordCells;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

interface Geometry {
  cols: number;
  rows: number;
  capacity: number;
}

export function geometry(shape: Shape, size: number = shape.frameSize): Geometry {
  const gridCols = Math.floor(size / shape.cellWidth);
  const rows = Math.floor(size / shape.cellHeight / shape.lineRepeat);
  if (shape.columns === 2) {
    const cols = Math.floor((gridCols - DOC_GUTTER) / 2);
    return { cols, rows, capacity: 2 * cols * rows };
  }
  return { cols: gridCols, rows, capacity: gridCols * rows };
}

function docPages(normalized: string, geo: Geometry, wideCells: boolean): string[] {
  const lines = wrap(normalized, geo.cols, wideCells);
  const perPage = 2 * geo.rows;
  const pages: string[] = [];
  for (let offset = 0; offset < lines.length; offset += perPage) {
    pages.push(lines.slice(offset, offset + perPage).join("\n"));
  }
  return pages;
}

function renderedChars(text: string, shape: Shape, geo: Geometry): number {
  if (shape.columns === 2) {
    let visible = [...text].length - (text.match(DIM_MARKERS)?.length ?? 0);
    visible -= text.match(/\n/g)?.length ?? 0;
    return Math.min(visible, geo.capacity);
  }
  const wideCells = usesWideCells(shape);
  let cell = 0;
  let count = 0;
  for (const ch of text) {
    const w = charCells(ch, wideCells);
    if (w === 0) continue;
    let at = cell;
    if (w === 2 && geo.cols >= 2 && at % geo.cols === geo.cols - 1) at += 1;
    if (at + w > geo.capacity) break;
    cell = at + w;
    count++;
  }
  return count;
}

export interface RenderedFrame {
  data: string;
  cols: number;
  rows: number;
  chars: number;
}

async function render(text: string, shape: Shape, size: number): Promise<RenderedFrame> {
  const geo = geometry(shape, size);
  const chars = renderedChars(text, shape, geo);
  const data = await getNative().renderSnapcompactPng(text, {
    size,
    font: shape.font,
    cellWidth: shape.cellWidth,
    cellHeight: shape.cellHeight,
    stretch: shape.stretch,
    variant: shape.variant,
    lineRepeat: shape.lineRepeat,
    columns: shape.columns,
  });
  return { data, cols: geo.cols, rows: geo.rows, chars };
}

function pageFinisher(shape: Shape): (page: string) => string {
  let dimOpen = false;
  return page => {
    const text = dimOpen ? DIM_ON + page : page;
    dimOpen = text.lastIndexOf(DIM_ON) > text.lastIndexOf(DIM_OFF);
    return shape.stopwordDim ? dimStopwords(text) : text;
  };
}

/** Split normalized text into per-frame page strings for a shape. */
export function paginate(text: string, shape: Shape, frameSize: number = shape.frameSize): string[] {
  const geo = geometry(shape, frameSize);
  const normalized = normalize(text, shape);
  const wideCells = usesWideCells(shape);
  if (shape.columns === 2) {
    const finish = pageFinisher(shape);
    return docPages(normalized, geo, wideCells).map(finish);
  }
  return paginateCells(normalized, geo.capacity, geo.cols, wideCells).map(page =>
    shape.stopwordDim ? dimStopwords(page) : page,
  );
}

// ============================================================================
// Core-message serialization (adapted from serializeConversation)
// ============================================================================

const TOOL_RESULT_MAX_CHARS = 2000;
const TOOL_CALL_MAX_CHARS = 2000;
const TRUNCATE_HEAD_RATIO = 0.6;

function truncateForSummary(text: string, maxChars: number, headRatio: number): string {
  if (text.length <= maxChars) return text;
  const ratio = Math.min(Math.max(headRatio, 0), 1);
  const headChars = Math.round(maxChars * ratio);
  const tailChars = maxChars - headChars;
  const elided = text.length - maxChars;
  const tail = tailChars > 0 ? text.slice(-tailChars) : "";
  return `${text.slice(0, headChars)} […${elided}ch elided…] ${tail}`;
}

/** Serialize acp-kernel core messages into archive text (¶-scoped sections,
 *  tool output dimmed and merged under its call). */
export function serializeCore(messages: CoreMessage[]): string {
  const parts: string[] = [];
  let lastPrefix: string | null = null;
  const pushPart = (prefix: string, content: string) => {
    const lastIndex = parts.length - 1;
    const prev = lastIndex >= 0 ? parts[lastIndex] : undefined;
    if (prev !== undefined && lastPrefix === prefix) {
      const sep = prev.endsWith("\n") || content.startsWith("\n") ? "" : "\n";
      parts[lastIndex] = prev + sep + content;
    } else {
      parts.push(prefix + content);
      lastPrefix = prefix;
    }
  };

  const resultTextByCallId = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "tool" && m.contentType === "tool-result" && m.text) {
      resultTextByCallId.set(m.toolCallId ?? m.id, m.text);
    }
  }

  const renderResultBlock = (rawText: string): string => {
    const body = truncateForSummary(stripDimMarkers(rawText), TOOL_RESULT_MAX_CHARS, TRUNCATE_HEAD_RATIO);
    return `<out>\n${DIM_ON}${body}${DIM_OFF}\n</out>`;
  };

  const mergedCallIds = new Set<string>();
  for (const m of messages) {
    const text = m.text ?? "";
    if (m.role === "user" && m.contentType === "text") {
      if (text) pushPart("¶user:", stripDimMarkers(text));
    } else if (m.role === "assistant" && m.contentType === "text") {
      if (text.trim()) pushPart("¶ai:", stripDimMarkers(text));
    } else if (m.role === "assistant" && m.contentType === "reasoning") {
      if (text.trim()) pushPart("¶think:", stripDimMarkers(text));
    } else if (m.role === "assistant" && m.contentType === "tool-call") {
      const key = m.toolCallId ?? m.id;
      const firstLine = `${m.toolName ?? "tool"}(${truncateForSummary(stripDimMarkers(text), TOOL_CALL_MAX_CHARS, TRUNCATE_HEAD_RATIO)})`;
      const resultText = resultTextByCallId.get(key);
      if (resultText !== undefined) {
        mergedCallIds.add(key);
        pushPart("¶call:", `${firstLine}\n${renderResultBlock(resultText)}`);
      } else {
        pushPart("¶call:", firstLine);
      }
    } else if (m.role === "tool" && m.contentType === "tool-result") {
      const key = m.toolCallId ?? m.id;
      if (mergedCallIds.has(key)) continue;
      const resultText = resultTextByCallId.get(key);
      if (resultText !== undefined) pushPart("¶call:", `\n${renderResultBlock(resultText)}`);
    }
  }
  return parts.join("\n\n");
}

// ============================================================================
// Frame store and context attachment
// ============================================================================

export interface SnapFrame {
  sha: string;
  bytes: number;
  tokens: number;
}

export interface SnapBatch {
  /** Block ids rendered into this batch's frames (all of them). */
  blockIds: string[];
  /** Frame shas in page order. */
  shas: string[];
  tokens: number;
  archivedAt: number;
}

export interface SnapManifest {
  frames: SnapFrame[];
  archivedIds: string[];
  /** v2 block-snap batches; flat `frames` is rebuilt from these when present. */
  batches?: SnapBatch[];
}

export const DEFAULT_MAX_FRAMES = 16;
/** Official hard cap: a caller-supplied maxFrames can only lower, never raise. */
export const MAX_FRAMES_HARD = 80;

export function emptyManifest(): SnapManifest {
  return { frames: [], archivedIds: [], batches: [] };
}

export function loadManifest(sessionFile: string): SnapManifest {
  try {
    const parsed = JSON.parse(readFileSync(`${sessionFile}.snap.json`, "utf8")) as Partial<SnapManifest>;
    const frames = Array.isArray(parsed.frames)
      ? parsed.frames.filter(
          (f): f is SnapFrame =>
            !!f && typeof f.sha === "string" && typeof f.bytes === "number" && typeof f.tokens === "number",
        )
      : [];
    const batches = Array.isArray(parsed.batches)
      ? parsed.batches.filter(
          (b): b is SnapBatch =>
            !!b && Array.isArray(b.blockIds) && Array.isArray(b.shas) && typeof b.tokens === "number" && typeof b.archivedAt === "number",
        )
      : undefined;
    return {
      frames,
      archivedIds: Array.isArray(parsed.archivedIds) ? parsed.archivedIds.filter((id): id is string => typeof id === "string") : [],
      batches,
    };
  } catch {
    return emptyManifest();
  }
}

export function saveManifest(sessionFile: string, manifest: SnapManifest): void {
  writeFileSync(`${sessionFile}.snap.json`, JSON.stringify(manifest));
}

export function frameTokens(manifest: SnapManifest): number {
  return manifest.frames.reduce((sum, f) => sum + f.tokens, 0);
}

const frameDataCache = new Map<string, string>();

function snapStoreDir(): string {
  return process.env.ACP_SNAP_DIR ?? join(homedir(), CONFIG_DIR_NAME, "snap");
}

function frameFile(sha: string): string {
  return join(snapStoreDir(), `${sha}.png`);
}

/** Render discarded core messages into frames, persist PNGs content-addressed
 *  under the snap store dir, and extend the session manifest. */
export async function archiveDiscarded(options: {
  sessionFile: string;
  discarded: CoreMessage[];
  manifest: SnapManifest;
  model?: ShapeTarget;
  variant?: ShapeVariantName;
  maxFrames: number;
}): Promise<{ manifest: SnapManifest; added: number }> {
  const { sessionFile, discarded, manifest, model, variant, maxFrames } = options;
  const fresh = discarded.filter(m => !manifest.archivedIds.includes(m.id));
  const archivedIds = [...manifest.archivedIds, ...fresh.map(m => m.id)];
  const text = serializeCore(fresh);
  if (!text.trim()) return { manifest: { frames: manifest.frames, archivedIds }, added: 0 };
  const shape = resolveShapeForText(text, model, variant ?? "auto");
  const pages = paginate(text, shape, shape.frameSize);
  if (pages.length === 0) return { manifest: { frames: manifest.frames, archivedIds }, added: 0 };
  const rendered = await Promise.all(pages.map(page => render(page, shape, shape.frameSize)));
  const frames = [...manifest.frames];
  for (const frame of rendered) {
    const sha = createHash("sha256").update(frame.data).digest("hex").slice(0, 32);
    const file = frameFile(sha);
    const bytes = Buffer.byteLength(frame.data, "base64");
    if (!existsSync(file)) {
      mkdirSync(snapStoreDir(), { recursive: true });
      writeFileSync(file, Buffer.from(frame.data, "base64"));
    }
    frames.push({ sha, bytes, tokens: shape.frameTokenEstimate });
  }
  const capped = frames.length > maxFrames ? frames.slice(frames.length - maxFrames) : frames;
  const next: SnapManifest = { frames: capped, archivedIds };
  saveManifest(sessionFile, next);
  return { manifest: next, added: rendered.length };
}

// ============================================================================
// Block-summary archiving (snap channel): render compressed-block summaries
// into frames, tracked per batch so GC can evict when blocks are consumed.
// ============================================================================

export interface BlockSnapshot {
  blockId: string;
  tier: number;
  topic?: string;
  summary: string;
  /** Official-style scoped serialization of the block's original messages
   *  (¶user:/¶ai:/¶call:, tool output dimmed). Preferred over `summary` when
   *  present — frames then read like official archives instead of flat text. */
  source?: string;
}

/** Serialize block archives the way the official serializer bounds source
 *  text: one labeled section per block, chronological. Scoped source wins so
 *  frames visually match official snapcompact; summary is the fallback for
 *  callers without the original messages (idle maintenance). */
export function serializeBlocks(blocks: BlockSnapshot[]): string {
  return blocks
    .map((b) => {
      const header = `[block ${b.blockId} t${b.tier}]${b.topic ? ` ${b.topic}` : ""}`;
      const body = b.source?.trim() ? b.source.trim() : b.summary.trim();
      return `${header}\n${body}`;
    })
    .join("\n\n");
}
/** Rebuild the flat frame list from batches (GC + FIFO cap). Frames whose PNG
 *  vanished from disk are dropped here too (buildSnapMessage would skip them
 *  anyway, but billing estimates must not count missing frames). */
export function rebuildFramesFromBatches(manifest: SnapManifest, maxFrames: number): SnapManifest {
  const batches = manifest.batches ?? [];
  const shaToFrame = new Map<string, SnapFrame>(manifest.frames.map((f) => [f.sha, f]));
  const frames: SnapFrame[] = [];
  for (const batch of batches) {
    for (const sha of batch.shas) {
      const frame = shaToFrame.get(sha);
      if (frame && existsSync(frameFile(sha))) frames.push(frame);
    }
  }
  const capped = frames.length > maxFrames ? frames.slice(frames.length - maxFrames) : frames;
  const kept = new Set(capped.map((f) => f.sha));
  const cappedBatches = batches
    .map((b) => ({ ...b, shas: b.shas.filter((s) => kept.has(s)) }))
    .filter((b) => b.shas.length > 0);
  return { frames: capped, archivedIds: manifest.archivedIds, batches: cappedBatches };
}

/** Render block summaries into frames and append them as one batch. Source
 *  text is re-serialized from the blocks themselves (official-style: frames
 *  are a pure function of Archive.text, never blind carry-forward). */
export async function archiveBlocks(options: {
  sessionFile: string;
  blocks: BlockSnapshot[];
  manifest: SnapManifest;
  model?: ShapeTarget;
  variant?: ShapeVariantName;
  maxFrames: number;
}): Promise<{ manifest: SnapManifest; added: number }> {
  const { sessionFile, blocks, manifest, model, variant, maxFrames } = options;
  const fresh = blocks.filter((b) => !manifest.archivedIds.includes(b.blockId));
  if (fresh.length === 0) return { manifest, added: 0 };
  const text = serializeBlocks(fresh);
  if (!text.trim()) return { manifest, added: 0 };
  const shape = resolveShapeForText(text, model, variant ?? "auto");
  const pages = paginate(text, shape, shape.frameSize);
  if (pages.length === 0) return { manifest, added: 0 };
  const rendered = await Promise.all(pages.map((page) => render(page, shape, shape.frameSize)));
  const frameBySha = new Map<string, SnapFrame>(manifest.frames.map((f) => [f.sha, f]));
  const shas: string[] = [];
  let batchTokens = 0;
  for (const frame of rendered) {
    const sha = createHash("sha256").update(frame.data).digest("hex").slice(0, 32);
    const file = frameFile(sha);
    if (!existsSync(file)) {
      mkdirSync(snapStoreDir(), { recursive: true });
      writeFileSync(file, Buffer.from(frame.data, "base64"));
    }
    const existing = frameBySha.get(sha);
    const entry: SnapFrame = existing ?? { sha, bytes: Buffer.byteLength(frame.data, "base64"), tokens: shape.frameTokenEstimate };
    frameBySha.set(sha, entry);
    shas.push(sha);
    batchTokens += entry.tokens;
  }
  const nextBatch: SnapBatch = { blockIds: fresh.map((b) => b.blockId), shas, tokens: batchTokens, archivedAt: Date.now() };
  const next: SnapManifest = {
    frames: [...manifest.frames, ...shas.filter((s) => !manifest.frames.some((f) => f.sha === s)).map((s) => frameBySha.get(s)!)],
    archivedIds: [...manifest.archivedIds, ...fresh.map((b) => b.blockId)],
    batches: [...(manifest.batches ?? []), nextBatch],
  };
  const rebuilt = rebuildFramesFromBatches(next, maxFrames);
  saveManifest(sessionFile, rebuilt);
  return { manifest: rebuilt, added: rendered.length };
}

/** Drop batches whose blocks are ALL gone from the active set (consumed by
 *  tier-2 distillation or deactivated), then rebuild + cap the frame list. */
export function gcManifest(manifest: SnapManifest, activeBlockIds: Set<string>, maxFrames: number): SnapManifest {
  const batches = manifest.batches;
  if (!batches || batches.length === 0) return manifest;
  const kept = batches.filter((b) => b.blockIds.some((id) => activeBlockIds.has(id)));
  if (kept.length === batches.length) return rebuildFramesFromBatches(manifest, maxFrames);
  return rebuildFramesFromBatches({ ...manifest, batches: kept }, maxFrames);
}

export interface SnapUserMessage {
  role: "user";
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
}

/** Rebuild the per-turn attachment message: one header plus every persisted
 *  frame, oldest first. Missing PNG files are skipped (cache dir cleaned). */
export function buildSnapMessage(manifest: SnapManifest): SnapUserMessage | undefined {
  if (manifest.frames.length === 0) return undefined;
  const content: SnapUserMessage["content"] = [
    {
      type: "text",
      text: `[ARCHIVED MIDDLE] ${manifest.frames.length} bitmap frame(s) of pruned history, oldest first. Read them when you need detail older than the visible transcript.`,
    },
  ];
  for (const frame of manifest.frames) {
    let data = frameDataCache.get(frame.sha);
    if (data === undefined) {
      const file = frameFile(frame.sha);
      if (!existsSync(file)) continue;
      data = readFileSync(file).toString("base64");
      frameDataCache.set(frame.sha, data);
    }
    content.push({ type: "image", data, mimeType: "image/png" });
  }
  return content.length > 1 ? { role: "user", content } : undefined;
}