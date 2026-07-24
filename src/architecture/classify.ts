/**
 * Pass 1 of the absorption algorithm (Ticket A.3, spec §5/§7): every
 * {@link GraphModel} node gets an architectural role via rule-table lookup
 * → structural heuristic → kept-unknown fallback.
 *
 * Pure and deterministic: neighbour "detailness" for the heuristic is
 * decided by rule lookup alone (never by other heuristic outcomes), so
 * classification is order-independent and needs no fixed-point iteration.
 */
import type { GraphModel } from '../common/interfaces.js';
import type { GraphNodeId } from '../common/types.js';
import { PLUMBING_SUFFIXES, RULES } from './rules.js';
import type { Role, TypeRule } from './types.js';

/**
 * One node's classification outcome:
 * - `rule`: an explicit {@link RULES} entry matched — carries the rule and
 *   its provenance name (`rule:<type>`).
 * - `heuristic`: no rule, but the structural heuristic (spec §7) matched —
 *   always a `detail`, with the single non-detail neighbour as its owner.
 * - `unknown`: nothing matched — kept visible (`kept-unknown`), reported
 *   via `unknownTypeCounts`.
 */
export type NodeClassification =
  | { kind: 'rule'; role: Role; rule: TypeRule; ruleName: string }
  | { kind: 'heuristic'; role: 'detail'; ownerId: GraphNodeId }
  | { kind: 'unknown' };

/** The classification pass's complete output. */
export interface ClassifyResult {
  /** Every node's outcome, keyed by node id — exactly one entry per input node. */
  classifications: Map<GraphNodeId, NodeClassification>;
  /**
   * Instance counts per type with no rule match (heuristic-matched types
   * included — the heuristic is a stopgap, not a rule, and reporting them
   * is what makes rule-table growth demand-driven). Nodes with no declared
   * type cannot be listed by type and are omitted.
   */
  unknownTypeCounts: Map<string, number>;
}

/** The provenance name recorded for heuristic matches (spec §3's example name). */
export const HEURISTIC_RULE_NAME = 'heuristic:single-neighbour-suffix-match';

/** Whether a type's last `::` segment ends with a plumbing suffix (without *being* just the suffix). */
function matchesPlumbingSuffix(type: string): boolean {
  const lastSegment = type.split('::').pop() ?? type;
  return PLUMBING_SUFFIXES.some((suffix) => lastSegment.endsWith(suffix) && lastSegment !== suffix);
}

/**
 * Classifies every node in `graph`. See {@link NodeClassification} for the
 * three outcomes; the accounting invariant (one classification per node)
 * is upheld here and asserted corpus-wide by the test suite.
 */
export function classify(graph: GraphModel): ClassifyResult {
  const classifications = new Map<GraphNodeId, NodeClassification>();
  const unknownTypeCounts = new Map<string, number>();

  // Adjacency, built once: distinct neighbours per node (either direction),
  // and distinct inbound-reference sources per node. Self-edges are ignored
  // — a resource referencing itself says nothing about ownership.
  const neighbours = new Map<GraphNodeId, Set<GraphNodeId>>();
  const inboundSources = new Map<GraphNodeId, Set<GraphNodeId>>();
  for (const edge of graph.edges) {
    if (edge.source === edge.target) continue;
    (neighbours.get(edge.source) ?? neighbours.set(edge.source, new Set()).get(edge.source)!).add(edge.target);
    (neighbours.get(edge.target) ?? neighbours.set(edge.target, new Set()).get(edge.target)!).add(edge.source);
    (inboundSources.get(edge.target) ?? inboundSources.set(edge.target, new Set()).get(edge.target)!).add(edge.source);
  }

  const typeById = new Map<GraphNodeId, string | undefined>(graph.nodes.map((n) => [n.id, n.type]));
  const isDetailByRule = (id: GraphNodeId): boolean => {
    const type = typeById.get(id);
    return type !== undefined && RULES[type]?.role === 'detail';
  };

  for (const node of graph.nodes) {
    const rule = node.type !== undefined ? RULES[node.type] : undefined;
    if (node.type !== undefined && rule !== undefined) {
      classifications.set(node.id, { kind: 'rule', role: rule.role, rule, ruleName: `rule:${node.type}` });
      continue;
    }

    if (node.type !== undefined) {
      unknownTypeCounts.set(node.type, (unknownTypeCounts.get(node.type) ?? 0) + 1);
    }

    // Structural heuristic (spec §7) — all three conditions, in order:
    // suffix match, exactly one non-detail neighbour, nothing referencing
    // it except that neighbour. Anything else errs noisy: kept visible.
    if (node.type !== undefined && matchesPlumbingSuffix(node.type)) {
      const nonDetailNeighbours = [...(neighbours.get(node.id) ?? [])].filter((id) => !isDetailByRule(id));
      if (nonDetailNeighbours.length === 1) {
        const owner = nonDetailNeighbours[0]!;
        const referencedByOthers = [...(inboundSources.get(node.id) ?? [])].some((id) => id !== owner);
        if (!referencedByOthers) {
          classifications.set(node.id, { kind: 'heuristic', role: 'detail', ownerId: owner });
          continue;
        }
      }
    }

    classifications.set(node.id, { kind: 'unknown' });
  }

  return { classifications, unknownTypeCounts };
}
