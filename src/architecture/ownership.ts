/**
 * Pass 3 of the absorption algorithm (Ticket A.5, spec §5): resolve which
 * surviving component/container each `detail`-role node is absorbed into.
 * Strategies, in order: (1) rule-declared `absorbInto` neighbour search
 * (candidate-priority order, both edge directions, one hop); (2) naming
 * convention (`ownerByNamePattern`, e.g. Log Groups' `/aws/{service}/{name}`);
 * (3) transitive chase through neighbourhoods made entirely of other
 * absorbables — depth-capped at 5, cycle-detected. No owner → the node
 * stays visible (`kept-unknown`), never silently dropped.
 *
 * Connector-role nodes are resolved here too: Ticket A.6 needs each
 * connector's degraded-detail absorption target, and the machinery is
 * identical. (Their *absorption* still happens in A.6, after edge
 * extraction — only the resolution is computed here.)
 */
import type { GraphModel, GraphNode } from '../common/interfaces.js';
import type { GraphNodeId, ResolvedValue } from '../common/types.js';
import type { NodeClassification } from './classify.js';

/** Transitive-chase depth cap (spec §5 Pass 3): an IAM Policy → Role → Lambda chain is 2 hops; anything past 5 is reported, not chased. */
const MAX_DEPTH = 5;

/** One node's ownership outcome. */
export type OwnerResolution =
  | {
      kind: 'resolved';
      /** The surviving component/container node this detail absorbs into — never itself an absorbable. */
      ownerId: GraphNodeId;
      /** Which strategy found it: direct rule-declared neighbour, name convention, transitive chase, or the classify-pass heuristic's single neighbour. */
      strategy: 'rule-neighbour' | 'name-pattern' | 'transitive' | 'heuristic-neighbour';
      /** `rule` when every hop was rule-declared; `heuristic` when any hop used a convention or heuristic. */
      confidence: 'rule' | 'heuristic';
    }
  | { kind: 'unresolved'; reason: string }
  /** The chain needed more than {@link MAX_DEPTH} hops — per the AC, identified explicitly (a real finding for A.11), never silently dropped or mis-resolved. */
  | { kind: 'depth-exceeded'; reason: string };

/** Internal chase outcome, distinguishing "failed because the chain re-entered itself" for honest cycle reporting. */
type ChaseResult = { resolution: OwnerResolution; sawCycle: boolean; sawDepth: boolean };

/** Whether a classification marks a node as absorbable (detail or connector) — the nodes that vanish rather than surviving as boxes/boundaries. */
export function isAbsorbableClassification(classification: NodeClassification | undefined): boolean {
  return (
    classification?.kind === 'heuristic' ||
    (classification?.kind === 'rule' && (classification.role === 'detail' || classification.role === 'connector'))
  );
}

/**
 * Builds the survivor-mapping function Passes 4 and 5 share: absorbables
 * map to their resolved owner (always a survivor, by resolver
 * construction); unresolved absorbables map to themselves — they stay
 * visible, so they *are* survivors.
 */
export function makeSurvivorResolver(
  classifications: Map<GraphNodeId, NodeClassification>,
  ownership: Map<GraphNodeId, OwnerResolution>,
): (id: GraphNodeId) => GraphNodeId {
  return (id) => {
    if (!isAbsorbableClassification(classifications.get(id))) return id;
    const resolution = ownership.get(id);
    return resolution?.kind === 'resolved' ? resolution.ownerId : id;
  };
}

/**
 * Resolves ownership for every detail- and connector-classified node.
 * Deterministic: neighbour candidates are scanned in candidate-priority
 * order first, node-id order second.
 */
export function resolveOwnership(
  graph: GraphModel,
  classifications: Map<GraphNodeId, NodeClassification>,
): Map<GraphNodeId, OwnerResolution> {
  const nodeById = new Map<GraphNodeId, GraphNode>(graph.nodes.map((n) => [n.id, n]));

  const neighbours = new Map<GraphNodeId, Set<GraphNodeId>>();
  for (const edge of graph.edges) {
    if (edge.source === edge.target) continue;
    (neighbours.get(edge.source) ?? neighbours.set(edge.source, new Set()).get(edge.source)!).add(edge.target);
    (neighbours.get(edge.target) ?? neighbours.set(edge.target, new Set()).get(edge.target)!).add(edge.source);
  }

  /** Detail- or connector-classified — the nodes that get absorbed rather than surviving as boxes/boundaries. */
  const isAbsorbable = (id: GraphNodeId): boolean => {
    const c = classifications.get(id);
    return c?.kind === 'heuristic' || (c?.kind === 'rule' && (c.role === 'detail' || c.role === 'connector'));
  };

  const sortedNeighboursOf = (id: GraphNodeId): GraphNodeId[] => [...(neighbours.get(id) ?? [])].sort();

  /** Top-level string properties of a node, for name-pattern matching. */
  const stringPropsOf = (node: GraphNode): Map<string, string> => {
    const out = new Map<string, string>();
    const props: ResolvedValue | undefined = node.properties;
    if (props?.kind !== 'object') return out;
    for (const entry of props.entries) {
      if (entry.value.kind === 'scalar' && typeof entry.value.value === 'string') out.set(entry.key, entry.value.value);
    }
    return out;
  };

  /** Strategy 2: match the rule's declared pattern (e.g. `/aws/{service}/{name}`) against a candidate whose rule-declared service equals {service} and whose logical ID or `*Name` property equals {name}. Exactly one match or nothing — never guessed. */
  const resolveByNamePattern = (node: GraphNode, pattern: string): GraphNodeId | undefined => {
    // Compile the data-declared pattern into a regex: {service} → one path
    // segment, {name} → the rest; everything else matched literally.
    const compiled = new RegExp(
      '^' +
        pattern
          .replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === '{' || c === '}' ? c : `\\${c}`))
          .replace('{service}', '([^/]+)')
          .replace('{name}', '(.+)') +
        '$',
    );
    let match: { service: string; name: string } | undefined;
    for (const value of stringPropsOf(node).values()) {
      const m = compiled.exec(value);
      if (m) {
        match = { service: m[1]!, name: m[2]! };
        break;
      }
    }
    if (match === undefined) return undefined;

    const candidates = graph.nodes.filter((candidate) => {
      const c = classifications.get(candidate.id);
      if (c?.kind !== 'rule' || (c.role !== 'component' && c.role !== 'container')) return false;
      if (c.rule.service !== match.service) return false;
      if (candidate.logicalId === match.name) return true;
      for (const [key, value] of stringPropsOf(candidate)) {
        if (key.endsWith('Name') && value === match.name) return true;
      }
      return false;
    });
    return candidates.length === 1 ? candidates[0]!.id : undefined;
  };

  /** The worse of two confidences (any heuristic hop taints the chain). */
  const worse = (a: 'rule' | 'heuristic', b: 'rule' | 'heuristic'): 'rule' | 'heuristic' => (a === 'heuristic' || b === 'heuristic' ? 'heuristic' : 'rule');

  const resolve = (id: GraphNodeId, stack: GraphNodeId[]): ChaseResult => {
    if (stack.includes(id)) {
      return { resolution: { kind: 'unresolved', reason: 'ownership chain cycles back to this resource' }, sawCycle: true, sawDepth: false };
    }
    if (stack.length >= MAX_DEPTH) {
      return {
        resolution: { kind: 'depth-exceeded', reason: `ownership chain exceeds the transitive-resolution depth cap of ${MAX_DEPTH}` },
        sawCycle: false,
        sawDepth: true,
      };
    }

    const node = nodeById.get(id)!;
    const classification = classifications.get(id)!;
    const nextStack = [...stack, id];
    let sawCycle = false;
    let sawDepth = false;

    /** Chase a candidate owner: direct if it survives, recursive if it's absorbable too. */
    const chase = (candidateId: GraphNodeId, directStrategy: 'rule-neighbour' | 'heuristic-neighbour', directConfidence: 'rule' | 'heuristic'): OwnerResolution | undefined => {
      if (!isAbsorbable(candidateId)) {
        return { kind: 'resolved', ownerId: candidateId, strategy: directStrategy, confidence: directConfidence };
      }
      const inner = resolve(candidateId, nextStack);
      sawCycle ||= inner.sawCycle;
      sawDepth ||= inner.sawDepth;
      if (inner.resolution.kind === 'resolved') {
        return { kind: 'resolved', ownerId: inner.resolution.ownerId, strategy: 'transitive', confidence: worse(directConfidence, inner.resolution.confidence) };
      }
      return undefined;
    };

    // Heuristic-classified: the classify pass already found the single
    // non-detail neighbour — but it may itself be a connector, so chase.
    if (classification.kind === 'heuristic') {
      const resolved = chase(classification.ownerId, 'heuristic-neighbour', 'heuristic');
      if (resolved !== undefined) return { resolution: resolved, sawCycle, sawDepth };
    }

    if (classification.kind === 'rule') {
      const sorted = sortedNeighboursOf(id);

      // Strategy 1 — rule-declared neighbour search, candidate-priority order.
      for (const candidateType of classification.rule.absorbInto ?? []) {
        for (const neighbourId of sorted) {
          if (nodeById.get(neighbourId)?.type !== candidateType) continue;
          const resolved = chase(neighbourId, 'rule-neighbour', 'rule');
          if (resolved !== undefined) return { resolution: resolved, sawCycle, sawDepth };
        }
      }

      // Strategy 2 — naming convention.
      if (classification.rule.ownerByNamePattern !== undefined) {
        const ownerId = resolveByNamePattern(node, classification.rule.ownerByNamePattern);
        if (ownerId !== undefined) {
          return { resolution: { kind: 'resolved', ownerId, strategy: 'name-pattern', confidence: 'heuristic' }, sawCycle, sawDepth };
        }
      }

      // Strategy 3 — transitive: only when the entire neighbourhood is
      // absorbable (a surviving neighbour that didn't match absorbInto is
      // a plausible owner the rules didn't anticipate — err noisy there).
      // All chased owners must agree; disagreement is ambiguity, not a guess.
      if (sorted.length > 0 && sorted.every((n) => isAbsorbable(n))) {
        const owners = new Map<GraphNodeId, 'rule' | 'heuristic'>();
        for (const neighbourId of sorted) {
          if (nextStack.includes(neighbourId)) continue;
          const inner = resolve(neighbourId, nextStack);
          sawCycle ||= inner.sawCycle;
          sawDepth ||= inner.sawDepth;
          if (inner.resolution.kind === 'resolved') {
            owners.set(inner.resolution.ownerId, worse(owners.get(inner.resolution.ownerId) ?? 'rule', inner.resolution.confidence));
          }
        }
        if (owners.size === 1) {
          const [[ownerId, confidence]] = [...owners] as [[GraphNodeId, 'rule' | 'heuristic']];
          return { resolution: { kind: 'resolved', ownerId, strategy: 'transitive', confidence }, sawCycle, sawDepth };
        }
        if (owners.size > 1) {
          return {
            resolution: { kind: 'unresolved', reason: 'transitive neighbours resolve to different owners — ambiguous, kept visible rather than guessed' },
            sawCycle,
            sawDepth,
          };
        }
      }
    }

    if (sawDepth) {
      return { resolution: { kind: 'depth-exceeded', reason: `ownership chain exceeds the transitive-resolution depth cap of ${MAX_DEPTH}` }, sawCycle, sawDepth };
    }
    return {
      resolution: {
        kind: 'unresolved',
        reason: sawCycle ? 'no owner found — the only ownership chains cycle back to this resource' : 'no owning component or container found among neighbours, name conventions, or transitive chains',
      },
      sawCycle,
      sawDepth,
    };
  };

  const resolutions = new Map<GraphNodeId, OwnerResolution>();
  for (const node of graph.nodes) {
    if (!isAbsorbable(node.id)) continue;
    resolutions.set(node.id, resolve(node.id, []).resolution);
  }
  return resolutions;
}
