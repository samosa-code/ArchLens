/**
 * The Architecture Generator's entry point (Sprint 3.5):
 * `GraphModel → ArchitectureGraph`, a pure function with no I/O.
 *
 * Pipeline state as of Ticket A.9 — Passes 1–6 wired: classification
 * (`classify.ts`), containers & nesting (`containers.ts`), ownership
 * resolution (`ownership.ts`), connector-edge extraction against the
 * intact graph (`connectors.ts`), edge reparenting + provenance-union
 * dedupe (`reparent.ts`), layer-index-driven direction inference
 * (`layers.ts`), and the synthetic Internet/Users node (`synthetic.ts`).
 * The accounting invariant (exactly one decision per input node) holds at
 * every stage — the synthetic node is deliberately excluded from it (it
 * has no input node to account for).
 */
import type { GraphModel, GraphNode } from '../common/interfaces.js';
import { classify, HEURISTIC_RULE_NAME, type NodeClassification } from './classify.js';
import { extractConnectorEdges } from './connectors.js';
import { buildContainers } from './containers.js';
import { inferDirection } from './layers.js';
import type { FileAnnotations } from './metadata.js';
import { resolveOwnership } from './ownership.js';
import { reparentAndDedupe } from './reparent.js';
import { addSyntheticNodes } from './synthetic.js';
import type { AbsorbedResource, AbstractionDecision, ArchitectureGraph, ArchNode } from './types.js';

/** Optional inputs `generate()` accepts beyond the graph itself. */
export interface GenerateOptions {
  /** Per-file account/region declarations (PO Question 27's metadata convention) — see `metadata.ts`'s `readFileAnnotations()`. */
  fileAnnotations?: FileAnnotations;
}

/** What a classified-but-not-yet-transformed node's decision says: the role is known; the pass that completes its fate hasn't run yet. */
const INTERIM_ROLE_REASON: Record<string, string> = {
  component: 'Classified as a component — a visible box on the diagram.',
  detail: 'Classified as a detail — absorption into an owner lands with Ticket A.5; kept visible until then.',
  connector: 'Classified as a connector — edge extraction lands with Ticket A.6; kept visible until then.',
};

function decisionFor(node: GraphNode, classification: NodeClassification): AbstractionDecision {
  switch (classification.kind) {
    case 'rule':
      if (classification.role === 'container') {
        return {
          nodeId: node.id,
          action: 'promoted-to-container',
          rule: classification.ruleName,
          reason: 'Promoted to a container — a boundary drawn around its contents, not a box of its own.',
          confidence: 'rule',
        };
      }
      return {
        nodeId: node.id,
        action: 'kept',
        rule: classification.ruleName,
        reason: INTERIM_ROLE_REASON[classification.role]!,
        confidence: 'rule',
      };
    case 'heuristic':
      return {
        nodeId: node.id,
        action: 'kept',
        rule: HEURISTIC_RULE_NAME,
        reason:
          `Type ${node.type ?? '(undeclared)'} has no rule, but matches a plumbing suffix with exactly one ` +
          'non-detail neighbour and no other references — absorption into that neighbour lands with Ticket A.5; kept visible until then.',
        confidence: 'heuristic',
      };
    case 'unknown':
      return {
        nodeId: node.id,
        action: 'kept-unknown',
        rule: 'fallback:kept-unknown',
        reason: `No classification rule exists yet for type ${node.type ?? '(undeclared)'} — kept visible in the unassigned layer.`,
        confidence: 'fallback',
      };
  }
}

/** The visible ArchNode for a (still-unabsorbed) node: rule-declared layer/service where classified, `unassigned`/`unknown` otherwise. */
function archNodeFor(node: GraphNode, classification: NodeClassification, decision: AbstractionDecision, containerId: string | undefined): ArchNode {
  const rule = classification.kind === 'rule' ? classification.rule : undefined;
  return {
    id: node.id,
    label: node.logicalId,
    service: rule?.service ?? 'unknown',
    resourceType: node.type ?? '(undeclared)',
    layer: rule?.layer ?? 'unassigned',
    ...(containerId !== undefined ? { containerId } : {}),
    sourceNodeId: node.id,
    file: node.file,
    line: node.pos.line,
    absorbed: [],
    decision,
    badges: [],
  };
}

/**
 * Produces the {@link ArchitectureGraph} for a {@link GraphModel}.
 *
 * Invariant (asserted corpus-wide by `__test__/generate.test.ts`, and
 * binding on every future ticket that touches this pipeline):
 * `decisions` contains exactly one entry per input node.
 */
/** Whether a classification is a detail (rule- or heuristic-classified) — the nodes Pass 3 absorbs. Connectors wait for A.6's edge extraction. */
function isDetail(classification: NodeClassification): boolean {
  return classification.kind === 'heuristic' || (classification.kind === 'rule' && classification.role === 'detail');
}

const STRATEGY_DESCRIPTION: Record<string, string> = {
  'rule-neighbour': 'rule-declared owner found among its neighbours',
  'name-pattern': 'owner matched by naming convention',
  transitive: 'owner reached transitively through other absorbed resources',
  'heuristic-neighbour': 'its single non-detail neighbour (structural heuristic)',
};

export function generate(graph: GraphModel, options?: GenerateOptions): ArchitectureGraph {
  const { classifications, unknownTypeCounts } = classify(graph);
  const { containers, containerOf } = buildContainers(graph, classifications, options?.fileAnnotations);
  const ownership = resolveOwnership(graph, classifications);
  // Pass 4 runs against the still-intact graph — before anything below
  // removes absorbed nodes (spec §5: reversing this order loses edges).
  const extraction = extractConnectorEdges(graph, classifications, ownership);
  // Pass 5: reparent the original edges onto survivors and dedupe
  // everything with provenance union.
  const { edges, nodeIndex } = reparentAndDedupe(graph, classifications, ownership, extraction);
  const logicalIdById = new Map(graph.nodes.map((n) => [n.id, n.logicalId]));

  const decisions: AbstractionDecision[] = [];
  const nodes: ArchNode[] = [];
  const nodeById = new Map<string, ArchNode>();
  const absorbedInto = new Map<string, AbsorbedResource[]>(); // owner id → resources landing in it

  for (const node of graph.nodes) {
    const classification = classifications.get(node.id)!;

    // Pass 3: detail-role nodes with a resolved owner are absorbed —
    // removed as boxes, recorded on the owner. Unresolved ones stay
    // visible as kept-unknown (never silently dropped).
    if (isDetail(classification)) {
      const resolution = ownership.get(node.id)!;
      if (resolution.kind === 'resolved') {
        const ruleName = classification.kind === 'rule' ? classification.ruleName : HEURISTIC_RULE_NAME;
        const group = classification.kind === 'rule' ? (classification.rule.group ?? 'plumbing') : 'plumbing';
        const reason = `Absorbed into ${logicalIdById.get(resolution.ownerId) ?? resolution.ownerId} — ${STRATEGY_DESCRIPTION[resolution.strategy]!}.`;
        decisions.push({
          nodeId: node.id,
          action: 'absorbed',
          rule: ruleName,
          reason,
          confidence: resolution.confidence,
          absorbedInto: resolution.ownerId,
        });
        const list = absorbedInto.get(resolution.ownerId) ?? [];
        list.push({
          nodeId: node.id,
          logicalId: node.logicalId,
          resourceType: node.type ?? '(undeclared)',
          file: node.file,
          line: node.pos.line,
          group,
          reason,
        });
        absorbedInto.set(resolution.ownerId, list);
        continue;
      }
      // No owner: visible, with the resolver's honest reason.
      const decision: AbstractionDecision = {
        nodeId: node.id,
        action: 'kept-unknown',
        rule: classification.kind === 'rule' ? classification.ruleName : HEURISTIC_RULE_NAME,
        reason: `Classified as a detail but kept visible: ${resolution.reason}.`,
        confidence: 'fallback',
      };
      decisions.push(decision);
      const archNode = archNodeFor(node, classification, decision, containerOf.get(node.id));
      nodes.push(archNode);
      nodeById.set(archNode.id, archNode);
      continue;
    }

    // Pass 4 outcome for connector-role nodes: converted to edge(s) and
    // recorded on the owner's panel, degraded to a plain absorbed detail
    // (endpoints unresolved), or kept visible when even absorption has
    // nowhere to go.
    if (classification.kind === 'rule' && classification.role === 'connector') {
      const resolution = ownership.get(node.id)!;
      const ownerId = resolution.kind === 'resolved' ? resolution.ownerId : undefined;
      const emittedAny = extraction.emitted.get(node.id) === true;
      const group = classification.rule.group ?? 'plumbing';

      if (ownerId !== undefined || emittedAny) {
        const edgeCount = extraction.edges.filter((e) => e.derivedFrom.some((p) => p.viaNodeId === node.id)).length;
        // A connector that emitted edges but has no absorbInto owner still
        // needs a panel home: the first emitted edge's target (per spec §5
        // Pass 4 — "absorbed into whichever endpoint did resolve").
        const panelOwnerId = ownerId ?? extraction.edges.find((e) => e.derivedFrom.some((p) => p.viaNodeId === node.id))!.target;
        // Keep the nodeIndex consistent with where the connector actually
        // ended up when ownership resolution alone had no answer.
        nodeIndex[node.id] = panelOwnerId;
        const reason = emittedAny
          ? `Converted to ${edgeCount} edge(s) and recorded in ${logicalIdById.get(panelOwnerId) ?? panelOwnerId}'s panel.`
          : `Connector endpoints did not resolve to components — absorbed as a plain detail into ${logicalIdById.get(panelOwnerId) ?? panelOwnerId}.`;
        decisions.push({
          nodeId: node.id,
          action: emittedAny ? 'converted-to-edge' : 'absorbed',
          rule: classification.ruleName,
          reason,
          confidence: emittedAny ? 'rule' : resolution.kind === 'resolved' ? resolution.confidence : 'rule',
          absorbedInto: panelOwnerId,
        });
        const list = absorbedInto.get(panelOwnerId) ?? [];
        list.push({
          nodeId: node.id,
          logicalId: node.logicalId,
          resourceType: node.type ?? '(undeclared)',
          file: node.file,
          line: node.pos.line,
          group,
          reason,
        });
        absorbedInto.set(panelOwnerId, list);
        continue;
      }

      // No edges, no owner: visible, honest.
      const decision: AbstractionDecision = {
        nodeId: node.id,
        action: 'kept-unknown',
        rule: classification.ruleName,
        reason: `Classified as a connector but kept visible: no edges could be extracted and ${resolution.kind === 'resolved' ? 'no owner survived' : resolution.reason}.`,
        confidence: 'fallback',
      };
      decisions.push(decision);
      const archNode = archNodeFor(node, classification, decision, containerOf.get(node.id));
      nodes.push(archNode);
      nodeById.set(archNode.id, archNode);
      continue;
    }

    const decision = decisionFor(node, classification);
    decisions.push(decision);
    // Container-role nodes became boundaries (Pass 2) — everything else
    // (components, unknowns) is a visible box.
    if (decision.action === 'promoted-to-container') continue;
    const archNode = archNodeFor(node, classification, decision, containerOf.get(node.id));
    nodes.push(archNode);
    nodeById.set(archNode.id, archNode);
  }

  // Attach absorbed resources to their owners — an ArchNode or an
  // ArchContainer (owners are always survivors, by resolver construction).
  const containerById = new Map(containers.map((c) => [c.id, c]));
  let absorbedCount = 0;
  for (const [ownerId, resources] of absorbedInto) {
    const owner = nodeById.get(ownerId) ?? containerById.get(ownerId);
    // Owner is guaranteed to survive; if this ever throws, the resolver's
    // invariant broke and that must surface loudly, not silently.
    if (owner === undefined) throw new Error(`ArchLens internal invariant violated: absorbed-resource owner ${ownerId} is not a surviving node or container`);
    owner.absorbed.push(...resources);
    absorbedCount += resources.length;
  }

  // Descending instance frequency (alphabetical tiebreak): the ranked
  // worklist --explain prints, so the most common gap gets a rule first.
  const unknownTypes = [...unknownTypeCounts.keys()].sort(
    (a, b) => unknownTypeCounts.get(b)! - unknownTypeCounts.get(a)! || a.localeCompare(b),
  );

  // Pass 6 (Ticket A.8): layers are already rule-assigned on each ArchNode;
  // this only reorders edge endpoints where topology gives a real signal.
  const directedEdges = inferDirection(nodes, edges);

  // Ticket A.9: the synthetic Internet/Users node, if any public ingress
  // path was found — never part of the audit-log `decisions` array (it has
  // no source GraphModel node) or `stats.sourceNodeCount`/`absorbedCount`.
  const synthetic = addSyntheticNodes(graph, nodeIndex);
  const allNodes = synthetic.node !== undefined ? [...nodes, synthetic.node] : nodes;
  const allEdges = [...directedEdges, ...synthetic.edges];

  return {
    nodes: allNodes,
    edges: allEdges,
    containers,
    decisions,
    unknownTypes,
    nodeIndex,
    stats: {
      sourceNodeCount: graph.nodes.length,
      componentCount: allNodes.length,
      absorbedCount,
      connectorEdgeCount: allEdges.filter((e) => e.derivedFrom.some((p) => p.kind === 'connector')).length,
    },
  };
}
