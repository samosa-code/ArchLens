import type { GraphModel } from '../common/interfaces.js';
import type { RenderGraph, RenderNode } from './types.js';

/** Strips the `AWS::` prefix for a shorter, still-recognizable label suffix, e.g. `Lambda::Function`. */
function shortType(type: string | undefined): string | undefined {
  if (type === undefined) return undefined;
  return type.startsWith('AWS::') ? type.slice('AWS::'.length) : type;
}

/**
 * Projects a real Sprint 2 `GraphModel` down to the renderer's thin
 * `RenderGraph` contract (see `types.ts`) — a focused converter for
 * `demo.ts`'s own manual-verification use, not yet the full CLI wiring
 * Ticket 3.4 owns (argument parsing, `--out`, load warnings surfaced to
 * the user, etc.), though the mapping itself is the same either way.
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
