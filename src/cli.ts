#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from 'node:url';
import { glob } from 'glob';
import { loadTemplates } from './parser/loader.js';
import { mergeGraphs } from './graph/merge.js';
import type { GraphModel, TemplateLoadWarning } from './common/interfaces.js';

/**
 * Sprint 2's demo entry point: proves the full load → per-template graph →
 * multi-stack merge pipeline (Tickets 2.1–2.3) end to end from the command
 * line, accepting a glob of template files and printing a summary of the
 * merged `GraphModel` — node count, edge count by kind, and every resolved
 * and unresolved cross-stack reference (Ticket 2.4's own "Demo Scenario").
 * Evolved from Sprint 1's single-template JSON-dump demo (see
 * `docs/parser-architecture.md` for that pipeline's own detail — still
 * exercised internally by `mergeGraphs()`, just no longer the CLI's own
 * output format). Deliberately still minimal — no `--out` flag, no HTML
 * rendering. Sprint 3 (Ticket 3.4) builds the real
 * `npx archlens <glob> --out <dir>` CLI on top of this; this file is the
 * seed, not a placeholder to be thrown away.
 */

const DEFAULT_DEMO_GLOB = fileURLToPath(
  new URL('../examples/03-multi-stack-ecs-fargate/*/template.yaml', import.meta.url),
);

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

/** Renders a merged `GraphModel` (plus any file-load warnings) as a human-readable summary. */
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

async function main(): Promise<void> {
  const patterns = process.argv.slice(2);
  const inputPatterns = patterns.length > 0 ? patterns : [DEFAULT_DEMO_GLOB];

  const files = await resolveInputFiles(inputPatterns);
  if (files.length === 0) {
    console.error(`No template files matched: ${inputPatterns.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const { templates, warnings: loadWarnings } = loadTemplates(files);
  const graph = mergeGraphs(templates);

  console.log(summarize(graph, loadWarnings));
}

/**
 * Only run `main()` when this file is executed directly (`node cli.js ...`)
 * — never as a side effect of another module importing `resolveInputFiles`/
 * `summarize` for testing or reuse. `process.argv[1]` is the script Node
 * was invoked with; comparing it to this module's own URL is the standard
 * ESM equivalent of CommonJS's `require.main === module`.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
