#!/usr/bin/env node
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { glob } from 'glob';
import { loadTemplates } from './parser/loader.js';
import { mergeGraphs } from './graph/merge.js';
import { generate } from './architecture/generate.js';
import { explainReport } from './architecture/explain.js';
import { writeHtml } from './render/build.js';
import { architectureGraphToRenderGraph } from './render/fromArchitectureGraph.js';
import { graphModelToRenderGraph } from './render/fromGraphModelRaw.js';
import { filterRenderGraphByLayer } from './render/filterByLayer.js';
import type { GraphModel, TemplateLoadWarning } from './common/interfaces.js';
import type { RenderGraph } from './render/types.js';

/**
 * Ticket 3.4 — the real CLI: `npx archlens <glob...> --out <dir>` (PRD
 * Section 5's user flow, `internal-docs/PRD.md` line 66/93). Evolved from
 * Sprint 2's demo entry point (`resolveInputFiles`/`summarize`, both kept
 * — see their own tests — but no longer the default output): the
 * pipeline now runs all the way to a written `index.html`, through the
 * `GraphModel → ArchitectureGraph → RenderGraph` stage Sprint 3.5 added.
 *
 * Naming note: the sprint plan's own ticket text still says `npx
 * cfn-viz`, an earlier working name — `internal-docs/PRD.md` (the
 * authoritative spec), `package.json`'s own `"name": "archlens"`, and
 * every other doc in this repo (README, `docs/parser-architecture.md`)
 * already consistently use `archlens`. Implemented under that name, not
 * the stale one, per the primary source.
 */

/**
 * PRD Section 5's stated default (`./archlens-output`) — deliberately
 * relative to the CALLER's current working directory (`process.cwd()`),
 * not to wherever this package happens to be installed. Anchoring it to
 * `import.meta.url` instead (the way `render/demo.ts`/`architecture/demo.ts`
 * anchor their own fixed dev-only output paths) would write every real
 * user's diagram into the archlens package's own install directory
 * instead of their project — a real bug, caught directly by a subprocess
 * test run from a temp CWD, not by inspection.
 */
const DEFAULT_OUT_DIR = 'archlens-output';

/**
 * Expands one or more glob patterns (or literal file paths — `glob()`
 * handles both identically) into a de-duplicated, sorted list of absolute
 * file paths.
 *
 * `glob` treats `\` as its escape character, per standard glob syntax — a
 * Windows-style absolute path (`C:\Users\...`) fed to it as-is silently
 * matches nothing, since every backslash-separated segment is read as an
 * escape sequence rather than a directory separator (confirmed directly:
 * an unmodified `fileURLToPath()` result on Windows produced zero matches
 * for a real, existing file until normalized here). Forward slashes work
 * as path separators on Windows regardless of source, so normalizing every
 * pattern's backslashes to forward slashes before passing it to `glob()`
 * is correct on every platform, not just a Windows workaround.
 */
export async function resolveInputFiles(patterns: string[]): Promise<string[]> {
  const normalizedPatterns = patterns.map((pattern) => pattern.replace(/\\/g, '/'));
  const matchesPerPattern = await Promise.all(normalizedPatterns.map((pattern) => glob(pattern, { absolute: true, nodir: true })));
  return [...new Set(matchesPerPattern.flat())].sort();
}

/** Renders a merged `GraphModel` (plus any file-load warnings) as a human-readable summary — Sprint 2's own demo output, kept for its exported behavior/tests; no longer what the CLI prints by default (see `main()`). */
export function summarize(graph: GraphModel, loadWarnings: TemplateLoadWarning[]): string {
  const edgeCountsByKind = new Map<string, number>();
  for (const edge of graph.edges) {
    edgeCountsByKind.set(edge.kind, (edgeCountsByKind.get(edge.kind) ?? 0) + 1);
  }
  const crossStackEdges = graph.edges.filter((e) => e.kind === 'crossStackImport');
  const unresolvedImports = graph.warnings.filter((w) => w.kind === 'unresolvedImport');
  const otherGraphWarnings = graph.warnings.filter((w) => w.kind !== 'unresolvedImport');

  const lines: string[] = [];
  lines.push(`Templates loaded: ${new Set(graph.nodes.map((n) => n.file)).size}`);
  lines.push(`Nodes: ${graph.nodes.length}`);
  lines.push(
    `Edges: ${graph.edges.length}` +
      ([...edgeCountsByKind.entries()].length > 0
        ? ` (${[...edgeCountsByKind.entries()].map(([kind, count]) => `${kind}: ${count}`).join(', ')})`
        : ''),
  );
  lines.push('');
  lines.push(`Resolved cross-stack references: ${crossStackEdges.length}`);
  for (const edge of crossStackEdges) {
    lines.push(`  - ${edge.source} -> ${edge.target} (export "${edge.exportName}", matched ${edge.matchedVia})`);
  }
  lines.push(`Unresolved cross-stack references: ${unresolvedImports.length}`);
  for (const warning of unresolvedImports) {
    if (warning.kind === 'unresolvedImport') {
      lines.push(`  - ${warning.file}#${warning.logicalId}: ${warning.message}`);
    }
  }

  if (otherGraphWarnings.length > 0) {
    lines.push('');
    lines.push(`Other graph warnings: ${otherGraphWarnings.length}`);
    for (const warning of otherGraphWarnings) {
      if (warning.kind === 'dependsOnTargetInvalid') {
        lines.push(`  - ${warning.file}#${warning.logicalId}: ${warning.message}`);
      }
    }
  }

  if (loadWarnings.length > 0) {
    lines.push('');
    lines.push(`Files that failed to load: ${loadWarnings.length}`);
    for (const warning of loadWarnings) {
      lines.push(`  - ${warning.file}: ${warning.message}`);
    }
  }

  return lines.join('\n');
}

export interface CliOptions {
  /** Glob patterns / literal file paths — at least one required. */
  patterns: string[];
  /** `--out <dir>` — defaults to `./archlens-output` (PRD Section 5's own stated default) when omitted. */
  outDir: string;
  /** `--raw` (PO Question 21) — the original 1:1 `GraphModel` view, bypassing the Architecture Generator entirely. */
  raw: boolean;
  /** `--explain` — prints every `AbstractionDecision` plus the ranked `unknownTypes` worklist to stdout, alongside (not instead of) writing the HTML. Meaningless with `--raw` (no decisions exist in the 1:1 view). */
  explain: boolean;
  /** `--layer=<list>` — an allowlist of layers to keep; omitted means no allowlist filtering. Meaningless with `--raw` (no layer concept there). */
  layers?: string[];
  /** `--hide-monitoring` — opt-out (PO Question 17: monitoring is visible by default, never hidden by default). Meaningless with `--raw`. */
  hideMonitoring: boolean;
}

/** A parse failure — a human-readable message, never a thrown exception (argv mistakes are a normal, expected CLI outcome, not a crash). */
export interface CliParseError {
  error: string;
}

/** Parses `process.argv.slice(2)`-shaped argv into {@link CliOptions}, or a {@link CliParseError} if it doesn't make sense. No dependency on a flag-parsing library — the surface here is small and stable enough that a manual parser is clearer than a new dependency for it. */
export function parseArgs(argv: string[]): CliOptions | CliParseError {
  const patterns: string[] = [];
  let outDir: string | undefined;
  let raw = false;
  let explain = false;
  let layers: string[] | undefined;
  let hideMonitoring = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--out') {
      const value = argv[i + 1];
      if (value === undefined) return { error: '--out requires a directory argument' };
      outDir = value;
      i += 1;
    } else if (arg === '--raw') {
      raw = true;
    } else if (arg === '--explain') {
      explain = true;
    } else if (arg === '--hide-monitoring') {
      hideMonitoring = true;
    } else if (arg.startsWith('--layer=')) {
      layers = arg
        .slice('--layer='.length)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } else if (arg.startsWith('--')) {
      return { error: `Unknown flag: ${arg}` };
    } else {
      patterns.push(arg);
    }
  }

  if (patterns.length === 0) return { error: 'No template glob/file patterns provided. Usage: archlens <glob...> [--out <dir>] [--raw] [--explain] [--layer=<list>] [--hide-monitoring]' };

  return { patterns, outDir: outDir ?? DEFAULT_OUT_DIR, raw, explain, ...(layers !== undefined ? { layers } : {}), hideMonitoring };
}

/** Builds the `RenderGraph` `main()` writes to disk, applying `--raw`/`--layer`/`--hide-monitoring` per {@link CliOptions}. Exported for direct testing without a subprocess. */
export function buildRenderGraph(graph: GraphModel, options: CliOptions): { renderGraph: RenderGraph; explainOutput?: string } {
  if (options.raw) {
    if (options.explain || options.layers !== undefined || options.hideMonitoring) {
      console.error('--explain/--layer/--hide-monitoring have no effect with --raw — the 1:1 view has no abstraction decisions or layers to report/filter.');
    }
    return { renderGraph: graphModelToRenderGraph(graph) };
  }

  const arch = generate(graph);
  const renderGraph = filterRenderGraphByLayer(architectureGraphToRenderGraph(arch), {
    ...(options.layers !== undefined ? { allowLayers: options.layers } : {}),
    hideMonitoring: options.hideMonitoring,
  });
  return { renderGraph, ...(options.explain ? { explainOutput: explainReport(arch) } : {}) };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ('error' in parsed) {
    console.error(parsed.error);
    process.exitCode = 1;
    return;
  }

  const files = await resolveInputFiles(parsed.patterns);
  if (files.length === 0) {
    console.error(`No template files matched: ${parsed.patterns.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const { templates, warnings: loadWarnings } = loadTemplates(files);
  for (const warning of loadWarnings) console.error(`Failed to load ${warning.file}: ${warning.message}`);

  const graph = mergeGraphs(templates);
  const { renderGraph, explainOutput } = buildRenderGraph(graph, parsed);

  if (explainOutput !== undefined) console.log(explainOutput);

  const outPath = join(parsed.outDir, 'index.html');
  writeHtml(renderGraph, outPath);
  console.log(`Wrote ${outPath}`);
}

/**
 * Only run `main()` when this file is executed directly (`node cli.js ...`)
 * — never as a side effect of another module importing `resolveInputFiles`/
 * `summarize`/`parseArgs` for testing or reuse. `process.argv[1]` is the
 * script Node was invoked with; comparing it to this module's own URL is
 * the standard ESM equivalent of CommonJS's `require.main === module`.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
