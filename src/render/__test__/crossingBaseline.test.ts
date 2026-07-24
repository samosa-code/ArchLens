import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { loadTemplates } from '../../parser/loader.js';
import { mergeGraphs } from '../../graph/merge.js';
import { generate } from '../../architecture/generate.js';
import { architectureGraphToRenderGraph } from '../fromArchitectureGraph.js';
import { computeLayout } from '../layout.js';
import { countEdgeCrossings } from '../crossings.js';

/**
 * Ticket 3.6.3's own regression lock: measured directly against the real
 * 67-template `14-diverse-corpus` merge (not a synthetic stand-in) at three
 * points before landing this ticket's changes —
 *   - 107 crossings: the original baseline (default `network-simplex`
 *     ranker, straight-line edges).
 *   - 66 crossings: `ranker: 'longest-path'` alone, straight-line edges —
 *     the single biggest lever found, ~38% down from the original
 *     baseline, with no diagram-size cost (`nodesep`/`ranksep` unchanged).
 *   - 92 crossings: `longest-path` + orthogonal edge routing (this
 *     project's final shipped combination) — orthogonal routing genuinely
 *     *raises* the raw crossing count versus straight lines at the same
 *     ranker (each diagonal becomes 3 segments, and the added horizontal
 *     "jog" segments are more prone to crossing other edges' jogs at
 *     similar y-levels), but is still a real ~14% improvement over the
 *     original baseline, and was kept anyway because the ticket's own
 *     explicit ask was right-angle lines matching a supplied reference
 *     image, not the lowest possible number — crossing count is a proxy
 *     for clutter, not the definition of it (this test's own docstring,
 *     and the ticket's own AC, both say so).
 *
 * Asserted with headroom (`<= 100`, not an exact `92`) — protects against a
 * real regression (a future change that pushes this back toward 107+)
 * without being brittle to the kind of small, meaningless swings a minor
 * dagre-internal version bump could cause.
 */
const CORPUS_DIR = fileURLToPath(new URL('../../../examples/14-diverse-corpus/', import.meta.url));

function corpusFiles(): string[] {
  return readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort()
    .map((f) => CORPUS_DIR + f);
}

describe('edge-crossing regression lock — real 67-template corpus (Ticket 3.6.3)', () => {
  test('the full corpus merge stays at or below the measured post-improvement crossing count, not silently regressing back toward the pre-3.6.3 baseline', () => {
    const { templates } = loadTemplates(corpusFiles());
    const graph = mergeGraphs(templates);
    const arch = generate(graph);
    const renderGraph = architectureGraphToRenderGraph(arch);

    const layoutInput = {
      nodes: renderGraph.nodes.map((n) => ({ id: n.id, width: 120, height: 40, ...(n.containerId !== undefined ? { containerId: n.containerId } : {}) })),
      edges: renderGraph.edges,
      containers: (renderGraph.containers ?? []).map((c) => ({ id: c.id, ...(c.parentId !== undefined ? { parentId: c.parentId } : {}), minWidth: 120, minHeight: 50 })),
    };
    const layout = computeLayout(layoutInput);
    const crossings = countEdgeCrossings(layout.edges);

    expect(crossings).toBeLessThanOrEqual(100);
  });
});
