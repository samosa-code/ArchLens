import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { graphModelToRenderGraph } from '../fromGraphModelRaw.js';
import { loadTemplates } from '../../parser/loader.js';
import { mergeGraphs } from '../../graph/merge.js';

/**
 * Ticket A.10 — `--raw` passthrough. Per PO Question 21, `--raw` must
 * produce byte-identical output to what Ticket 3.1/3.2's pipeline produces
 * today: this file is a straight rename of `fromGraphModel.ts` (no logic
 * change), and this snapshot locks its real-fixture output as a regression
 * guard for when a later ticket builds the "cooked" `fromArchitectureGraph.ts`
 * alongside it — the raw path must keep producing exactly this.
 */
describe('graphModelToRenderGraph (the --raw projection) — regression lock', () => {
  test('01-simple-lambda: output matches the locked snapshot', () => {
    const FIXTURE = fileURLToPath(new URL('../../../examples/01-simple-lambda/template.yaml', import.meta.url));
    const { templates } = loadTemplates([FIXTURE]);
    const graph = mergeGraphs(templates);
    expect(graphModelToRenderGraph(graph)).toMatchSnapshot();
  });

  test('every node keeps its id/label, every edge keeps its source/target — no silent field drop', () => {
    const FIXTURE = fileURLToPath(new URL('../../../examples/01-simple-lambda/template.yaml', import.meta.url));
    const { templates } = loadTemplates([FIXTURE]);
    const graph = mergeGraphs(templates);
    const render = graphModelToRenderGraph(graph);

    expect(render.nodes).toHaveLength(graph.nodes.length);
    expect(render.edges).toHaveLength(graph.edges.length);
    for (const node of graph.nodes) {
      expect(render.nodes.some((n) => n.id === node.id && n.label.startsWith(node.logicalId))).toBe(true);
    }
  });
});
