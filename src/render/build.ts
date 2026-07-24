import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { loadIconDataUris } from './icons.js';
import type { RenderGraph } from './types.js';

export type { RenderGraph, RenderNode, RenderEdge } from './types.js';

/**
 * Absolute path to `render/browser/`, computed relative to *this file's own
 * location* — resolves to the same real directory whether this module runs
 * directly from `src/` (vitest) or from its compiled `dist/render/build.js`
 * counterpart, since `tsconfig.json`'s `rootDir`/`outDir` keep `src/` and
 * `dist/` mirrored at identical depth. Deliberately points back into `src/`
 * even from `dist/`: `browser/app.ts`/`template.html`/`style.css` are never
 * compiled by `tsc` (excluded from both `tsconfig.json` and
 * `tsconfig.build.json` — see those files) — `app.ts` is bundled by
 * `esbuild` directly from its TypeScript source at build time, and the
 * `.html`/`.css` files are plain text `tsc` would never touch anyway.
 */
const BROWSER_DIR = fileURLToPath(new URL('../../src/render/browser/', import.meta.url));

/**
 * Same anchoring rationale as {@link BROWSER_DIR}: resolves to the real
 * repo-root `assets/icons/` whether this module runs from `src/` or its
 * compiled `dist/` counterpart. Ticket 3.6.2 — real AWS service icons,
 * curated from the official Architecture Icons asset pack down to just the
 * ~50 service keys `src/architecture/rules.ts` actually uses, renamed to
 * match those keys exactly (see `assets/icons/`, no separate map to keep in
 * sync — `loadIconDataUris()`'s own doc comment).
 */
const ICONS_DIR = fileURLToPath(new URL('../../assets/icons/', import.meta.url));

/**
 * Bundles `render/browser/app.ts` with `graph` baked in as a literal (via
 * esbuild's `define` — the graph becomes actual JS source text, not a
 * runtime-fetched value), then inlines the resulting script plus
 * `style.css` into `template.html`. The returned string is one
 * self-contained HTML document: no `<script src>`, no `<link href>`, no
 * network request of any kind once opened (Ticket 3.1's acceptance
 * criteria — verified for real, not just by inspection, in
 * `__test__/build.test.ts` using a real headless browser with its network
 * context set fully offline).
 */
export function buildHtml(graph: RenderGraph): string {
  const icons = loadIconDataUris(ICONS_DIR);
  const result = esbuild.buildSync({
    entryPoints: [BROWSER_DIR + 'app.ts'],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2022',
    define: { __ARCHLENS_GRAPH_DATA__: JSON.stringify(graph), __ARCHLENS_ICON_DATA__: JSON.stringify(icons) },
  });

  const script = result.outputFiles[0]!.text;
  const style = readFileSync(BROWSER_DIR + 'style.css', 'utf-8');
  const template = readFileSync(BROWSER_DIR + 'template.html', 'utf-8');

  return template.replace('/*__ARCHLENS_STYLE__*/', () => style).replace('/*__ARCHLENS_SCRIPT__*/', () => script);
}

/** Builds the HTML (see {@link buildHtml}) and writes it to `outPath`, creating parent directories as needed. */
export function writeHtml(graph: RenderGraph, outPath: string): void {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, buildHtml(graph), 'utf-8');
}
