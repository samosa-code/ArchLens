/**
 * Pass 6 of the absorption algorithm (Ticket A.8, spec §6) — direction
 * inference. Layers themselves are already rule-assigned (each `ArchNode`
 * carries its `layer` from A.1/A.2); topology is used for exactly one
 * thing here, per kind:
 *
 *   containment -> untouched: already nesting, never an arrow.
 *   invocation  -> untouched: the connector declared this direction and
 *                  it's explicit and correct (spec §6).
 *   network     -> untouched: declared source SG -> target SG, as-is.
 *   dataAccess  -> accessor (the lower layer index) -> store. A tie keeps
 *                  the connector's declared order as-is and is NOT flagged
 *                  `heuristic` — the connector rule chose the accessor side
 *                  deliberately, independent of layer order.
 *   association -> ordered by layer index; a tie (or either endpoint
 *                  sitting outside the ordered edge..data range — i.e.
 *                  monitoring/network/unassigned) keeps the template's own
 *                  reference direction, which is genuinely arbitrary. This
 *                  is spec §6's documented limitation: flagged `heuristic`,
 *                  never silently presented as a verified direction.
 *
 * When an edge's direction IS flipped relative to the template, `inferred`
 * is set — visible in the detail panel (spec §3).
 *
 * Flipping can newly collide two edges that Pass 5 kept distinct: e.g. the
 * template has both an `Api -> Fn` and a `Fn -> Api` association (real case:
 * `09-sam-apigw-lambda-dynamodb`), Pass 5 dedupes each direction separately,
 * then Pass 6 flips the `Api -> Fn` one onto `Fn -> Api` — now a genuine
 * duplicate `(source,target,kind)`. Re-run the same union-not-discard merge
 * Pass 5 uses (`reparent.ts`) after flipping, so provenance from both never
 * silently disappears.
 */
import { LAYER_ORDER } from './rules.js';
import type { ArchEdge, ArchNode, EdgeProvenance } from './types.js';

/** The last layer that participates in flow ordering; monitoring/network/unassigned sit beyond it (spec §6) and never order. */
const MAX_FLOW_LAYER_INDEX = LAYER_ORDER.data;

/** Structural identity for one provenance entry, for unioning without duplicating identical entries (mirrors `reparent.ts`). */
function provenanceKey(p: EdgeProvenance): string {
  return [p.kind, p.viaNodeId ?? '', p.viaResourceType ?? '', p.file ?? '', p.line ?? '', (p.propertyPath ?? []).join('.')].join('|');
}

/** Merges edges sharing a (source, target, kind) key post-flip, unioning derivedFrom rather than discarding either side. */
function mergeByKey(edges: ArchEdge[]): ArchEdge[] {
  const merged = new Map<string, ArchEdge>();
  for (const edge of edges) {
    const key = `${edge.source} ${edge.target} ${edge.kind}`;
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, { ...edge, derivedFrom: [...edge.derivedFrom] });
      continue;
    }
    const seen = new Set(existing.derivedFrom.map(provenanceKey));
    for (const p of edge.derivedFrom) {
      if (!seen.has(provenanceKey(p))) {
        existing.derivedFrom.push(p);
        seen.add(provenanceKey(p));
      }
    }
    if (edge.confidence === 'heuristic') existing.confidence = 'heuristic';
    if (edge.inferred) existing.inferred = true;
    if (existing.label === undefined && edge.label !== undefined) existing.label = edge.label;
  }
  return [...merged.values()];
}

export function inferDirection(nodes: ArchNode[], edges: ArchEdge[]): ArchEdge[] {
  const layerOf = new Map(nodes.map((n) => [n.id, n.layer]));

  const directed = edges.map((edge): ArchEdge => {
    if (edge.kind === 'containment' || edge.kind === 'invocation' || edge.kind === 'network') return edge;

    const sourceLayer = layerOf.get(edge.source);
    const targetLayer = layerOf.get(edge.target);
    if (sourceLayer === undefined || targetLayer === undefined) return edge;

    const sourceIndex = LAYER_ORDER[sourceLayer];
    const targetIndex = LAYER_ORDER[targetLayer];
    const bothOrdered = sourceIndex <= MAX_FLOW_LAYER_INDEX && targetIndex <= MAX_FLOW_LAYER_INDEX;

    if (!bothOrdered || sourceIndex === targetIndex) {
      return edge.kind === 'association' ? { ...edge, confidence: 'heuristic' } : edge;
    }

    if (sourceIndex < targetIndex) return edge;

    return { ...edge, source: edge.target, target: edge.source, inferred: true };
  });

  return mergeByKey(directed);
}
