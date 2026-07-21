import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { loadTemplate, loadTemplates } from '../../parser/loader.js';
import { buildGraph } from '../model.js';
import { mergeGraphs } from '../merge.js';

/**
 * `examples/14-diverse-corpus` — 67 real, independent (non-cross-
 * referencing) templates fetched specifically to stress-test the parser +
 * graph pipeline against far more service types, authoring styles, and
 * template sizes than examples 01-13 exercise individually (per the user's
 * explicit request to surface integration-level gaps early, before Sprint
 * 3 builds on top). See `examples/14-diverse-corpus/SOURCE.md` for
 * provenance. This suite is what that stress-testing pass turned into a
 * permanent regression fixture, once it stopped finding new bugs.
 */
const CORPUS_DIR = fileURLToPath(new URL('../../../examples/14-diverse-corpus/', import.meta.url));

function corpusFiles(): string[] {
  return readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort()
    .map((f) => CORPUS_DIR + f);
}

describe('diverse real-world corpus — buildGraph does not crash on any of the 67 fixtures', () => {
  for (const file of corpusFiles()) {
    test(file.split(/[\\/]/).pop()!, () => {
      const ast = loadTemplate(file);
      expect(() => buildGraph(file, ast)).not.toThrow();
      const graph = buildGraph(file, ast);
      expect(graph.nodes.length).toBeGreaterThan(0);
      expect(graph.nodes.every((n) => n.file === file)).toBe(true);
      // Every reference/dependsOn edge must target a node that actually exists in this same graph.
      const ids = new Set(graph.nodes.map((n) => n.id));
      for (const edge of graph.edges) {
        expect(ids.has(edge.target)).toBe(true);
      }
    });
  }
});

describe('diverse real-world corpus — merged together at once (integration/scale)', () => {
  test('all 67 templates merge into one graph without crashing, in reasonable time', () => {
    const files = corpusFiles();
    const { templates, warnings: loadWarnings } = loadTemplates(files);
    expect(loadWarnings).toHaveLength(0);
    expect(templates).toHaveLength(files.length);

    const start = Date.now();
    const graph = mergeGraphs(templates);
    const elapsedMs = Date.now() - start;

    expect(graph.nodes.length).toBeGreaterThan(500);
    expect(elapsedMs).toBeLessThan(10_000);
  });

  test('PO Question 4d holds at real scale: logical IDs are reused across many unrelated templates, yet every node id stays unique', () => {
    const files = corpusFiles();
    const { templates } = loadTemplates(files);
    const graph = mergeGraphs(templates);

    const byLogicalId = new Map<string, number>();
    for (const node of graph.nodes) {
      byLogicalId.set(node.logicalId, (byLogicalId.get(node.logicalId) ?? 0) + 1);
    }
    const reusedLogicalIds = [...byLogicalId.values()].filter((count) => count > 1).length;
    // Real, confirmed count at time of writing: 59 logical IDs (e.g. "InstanceSecurityGroup",
    // reused by 10 unrelated templates) collide by name alone across this corpus.
    // Asserting "> 10" rather than the exact number: what matters is that reuse is
    // common, not the precise count, which could shift slightly if the corpus changes.
    expect(reusedLogicalIds).toBeGreaterThan(10);

    const nodeIds = graph.nodes.map((n) => n.id);
    expect(new Set(nodeIds).size).toBe(nodeIds.length);
  });

  test('every warning from the full merge is a legitimate, specific reason — not a crash or a vague catch-all', () => {
    const files = corpusFiles();
    const { templates } = loadTemplates(files);
    const graph = mergeGraphs(templates);

    for (const warning of graph.warnings) {
      expect(warning.kind).toMatch(/^(unresolvedImport|dependsOnTargetInvalid)$/);
      expect(warning.message.length).toBeGreaterThan(0);
    }
  });
});
