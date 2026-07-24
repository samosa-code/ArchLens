/**
 * Ticket 3.4's `--layer=<list>`/`--hide-monitoring` CLI flags: a pure
 * post-processing filter over an already-built `RenderGraph`, not a
 * generation-time concern — `fromArchitectureGraph.ts` always produces
 * the complete picture, and the CLI decides what subset to actually
 * write out.
 *
 * A node with no `layer` at all (the `--raw` 1:1 projection has no layer
 * concept) always survives — layer filtering simply doesn't apply there,
 * and the CLI treats both flags as a documented no-op in `--raw` mode
 * rather than dropping everything.
 */
import type { RenderGraph } from './types.js';

export interface LayerFilterOptions {
  /** `--layer=<list>` — an allowlist; a node with a declared `layer` NOT in this list is dropped. Omitted means no allowlist filtering at all. */
  allowLayers?: string[];
  /** `--hide-monitoring` — an opt-out on top of whatever the allowlist already kept (PO Question 17: monitoring is visible by default). */
  hideMonitoring?: boolean;
}

export function filterRenderGraphByLayer(graph: RenderGraph, options: LayerFilterOptions): RenderGraph {
  if (options.allowLayers === undefined && options.hideMonitoring !== true) return graph;

  const allowSet = options.allowLayers !== undefined ? new Set(options.allowLayers) : undefined;

  const nodes = graph.nodes.filter((node) => {
    if (node.layer === undefined) return true; // no layer concept (e.g. --raw) — filtering doesn't apply
    if (allowSet !== undefined && !allowSet.has(node.layer)) return false;
    if (options.hideMonitoring === true && node.layer === 'monitoring') return false;
    return true;
  });

  const survivingIds = new Set(nodes.map((n) => n.id));
  const edges = graph.edges.filter((edge) => survivingIds.has(edge.source) && survivingIds.has(edge.target));

  return { ...graph, nodes, edges };
}
