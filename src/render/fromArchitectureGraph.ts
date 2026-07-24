/**
 * Projects an {@link ArchitectureGraph} (Sprint 3.5) down to the renderer's
 * thin `RenderGraph` contract (see `types.ts`) — pulled forward into
 * Ticket 3.3 (see `internal-docs/SPRINT-PLAN.md`'s 2026-07-23 scope
 * decision): the click-for-details panel needs `ArchNode`-shaped data, and
 * this projection is the only place that data can come from, regardless
 * of which ticket number builds it. `fromGraphModelRaw.ts` remains the
 * `--raw` sibling — this file is `--raw`'s "cooked" counterpart.
 *
 * Three things happen here, matching the spec's own description of this
 * file's job: container → nesting-hint (containers pass through with
 * their `parentId` chain; member nodes carry `containerId` — actual
 * nested-box layout is a rendering concern, not this projection's), edge
 * kind → line style (`kind`/`delivery` carried through so `app.ts` can
 * style solid vs. dashed; `containment`-kind edges are dropped entirely,
 * since nesting is already expressed via `containerId`/`parentId` and
 * was never meant to be drawn as an arrow), and service → icon key
 * (`service` carried through as a plain string — real icon graphics are
 * Sprint 13's job, per `ArchNode.service`'s own doc comment).
 */
import type { ArchitectureGraph, ArchNode } from '../architecture/types.js';
import type { RenderAbsorbedResource, RenderBadge, RenderContainer, RenderEdge, RenderGraph, RenderNode } from './types.js';

function toRenderNode(node: ArchNode): RenderNode {
  const findingSourceIds = new Set(node.badges.map((b) => b.sourceNodeId));
  const absorbed: RenderAbsorbedResource[] = node.absorbed.map((a) => ({
    nodeId: a.nodeId,
    logicalId: a.logicalId,
    resourceType: a.resourceType,
    file: a.file,
    line: a.line,
    group: a.group,
    reason: a.reason,
    hasFinding: findingSourceIds.has(a.nodeId),
  }));
  const badges: RenderBadge[] = node.badges.map((b) => ({ kind: b.kind, message: b.message, sourceNodeId: b.sourceNodeId }));

  return {
    id: node.id,
    label: node.label,
    type: node.resourceType,
    service: node.service,
    layer: node.layer,
    ...(node.containerId !== undefined ? { containerId: node.containerId } : {}),
    ...(node.file !== undefined ? { file: node.file } : {}),
    ...(node.line !== undefined ? { line: node.line } : {}),
    absorbed,
    badges,
    decisionReason: node.decision.reason,
  };
}

export function architectureGraphToRenderGraph(arch: ArchitectureGraph): RenderGraph {
  const nodes = arch.nodes.map(toRenderNode);

  // containment is nesting, never an arrow (ArchEdgeKind's own doc
  // comment) — containerId/parentId already express it.
  const edges: RenderEdge[] = arch.edges
    .filter((e) => e.kind !== 'containment')
    .map((e) => ({
      source: e.source,
      target: e.target,
      kind: e.kind as 'invocation' | 'dataAccess' | 'network' | 'association',
      ...(e.label !== undefined ? { label: e.label } : {}),
      delivery: e.delivery,
      inferred: e.inferred,
    }));

  const containers: RenderContainer[] = arch.containers.map((c) => ({
    id: c.id,
    label: c.label,
    kind: c.kind,
    ...(c.parentId !== undefined ? { parentId: c.parentId } : {}),
  }));

  return { nodes, edges, containers };
}
