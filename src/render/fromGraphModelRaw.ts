import type { GraphModel } from '../common/interfaces.js';
import type { RenderGraph, RenderNode } from './types.js';

/** Strips the `AWS::` prefix for a shorter, still-recognizable label suffix, e.g. `Lambda::Function`. */
function shortType(type: string | undefined): string | undefined {
  if (type === undefined) return undefined;
  return type.startsWith('AWS::') ? type.slice('AWS::'.length) : type;
}

/**
 * Projects a real `GraphModel` down to the renderer's thin `RenderGraph`
 * contract (see `types.ts`) — the original Sprint 2 1:1 view, unchanged
 * since. Renamed from `fromGraphModel.ts` in Ticket A.10 (Sprint 3.5):
 * once the Architecture Generator's `GraphModel -> ArchitectureGraph`
 * stage exists, most rendering goes through a *cooked*
 * `fromArchitectureGraph.ts` projection instead — this file is what
 * `--raw` (PO Question 21: a fully supported flag, not a debug aid) and
 * drill-down keep using, preserved exactly as-is on purpose. Wiring an
 * actual `--raw` argv flag to it is Ticket 3.4's job (paused until after
 * Sprint 3.5); this module is the projection that flag will call.
 * `GraphEdge`'s three kinds (`reference`/`dependsOn`/`crossStackImport`)
 * all carry `source`/`target`, so no per-kind branching is needed here.
 */
export function graphModelToRenderGraph(graph: GraphModel): RenderGraph {
  return {
    nodes: graph.nodes.map((node): RenderNode => {
      const type = shortType(node.type);
      const label = type !== undefined ? `${node.logicalId} (${type})` : node.logicalId;
      // `exactOptionalPropertyTypes` means `type` must be omitted entirely
      // when unknown, not set to `undefined` — `node.type` really can be
      // `undefined` (a resource whose `Type` isn't a literal string).
      return node.type !== undefined ? { id: node.id, label, type: node.type } : { id: node.id, label };
    }),
    edges: graph.edges.map((edge) => ({ source: edge.source, target: edge.target })),
  };
}
