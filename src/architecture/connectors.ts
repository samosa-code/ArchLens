/**
 * Pass 4 of the absorption algorithm (Ticket A.6, spec §5): run every
 * connector-role node's {@link ConnectorSpec} *while the full graph is
 * still intact* — before any reparenting (Pass 5 / Ticket A.7), since
 * reversing the order silently loses edges.
 *
 * Endpoint resolution deliberately rides the {@link GraphModel}'s existing
 * reference/crossStackImport edges: their `propertyPath` already locates
 * every reference the parser found — including refs nested inside
 * partially-resolved `Fn::Join`/`Fn::Sub` values, which a naive property
 * walk would miss. A consequence that is a feature, not a gap: literal ARN
 * strings (and `'*'` wildcards) never created a graph edge, so they can
 * never produce an arch edge — PO Question 19's "never emit on a wildcard"
 * falls out of the mechanism instead of being a special case.
 *
 * A connector whose endpoints don't resolve emits nothing and degrades to
 * a plain absorbed detail (`emitted: false` — `generate()` acts on it).
 */
import type { GraphModel, GraphNode } from '../common/interfaces.js';
import type { GraphNodeId, ResolvedValue } from '../common/types.js';
import type { NodeClassification } from './classify.js';
import { makeSurvivorResolver, type OwnerResolution } from './ownership.js';
import type { ArchEdge, ConnectorSpec, EdgeDelivery, Endpoint } from './types.js';

/** Pass 4's complete output. */
export interface ConnectorExtraction {
  /** Every emitted edge, endpoints already mapped onto surviving nodes; duplicates are Pass 5's (A.7) dedupe-union problem, not dropped here. */
  edges: ArchEdge[];
  /** Per connector node: whether it emitted at least one edge — `false` means it degrades to a plain absorbed detail. */
  emitted: Map<GraphNodeId, boolean>;
}

/**
 * AWS service principals whose Lambda invocations are event-driven —
 * used only when a connector's spec omits `delivery` (PO Question 23:
 * `Lambda::Permission`'s delivery depends on who invokes).
 */
const ASYNC_PRINCIPAL_SERVICES = new Set(['s3', 'sns', 'sqs', 'events', 'iot', 'logs', 'config', 'ses']);

/** Numeric-tolerant path-prefix match: spec `a.b` matches graph propertyPath `['a','0','b','2']` — array indices in the actual path are skipped, and deeper nesting past the spec's end is allowed. */
function pathMatches(specPath: string, actualPath: string[]): boolean {
  const specSegments = specPath.split('.');
  let i = 0;
  for (const segment of actualPath) {
    if (i >= specSegments.length) return true;
    if (/^\d+$/.test(segment)) continue;
    if (segment !== specSegments[i]) return false;
    i += 1;
  }
  return i >= specSegments.length;
}

/** The node's top-level string property `key`, if present. */
function stringProp(node: GraphNode, key: string): string | undefined {
  const props: ResolvedValue | undefined = node.properties;
  if (props?.kind !== 'object') return undefined;
  const entry = props.entries.find((e) => e.key === key);
  return entry?.value.kind === 'scalar' && typeof entry.value.value === 'string' ? entry.value.value : undefined;
}

/** Infers sync/async from a `Principal` like `s3.amazonaws.com` — direct/request-response services are sync; event sources async; unknown defaults sync (a plain invoke). */
function inferDeliveryFromPrincipal(node: GraphNode): EdgeDelivery {
  const principal = stringProp(node, 'Principal');
  const service = principal?.split('.')[0];
  return service !== undefined && ASYNC_PRINCIPAL_SERVICES.has(service) ? 'async' : 'sync';
}

/**
 * Runs every connector's spec(s) and returns the emitted edges plus each
 * connector's emitted/degraded status. Deterministic: nodes in graph
 * order, specs in declaration order, endpoint matches in edge order.
 */
export function extractConnectorEdges(
  graph: GraphModel,
  classifications: Map<GraphNodeId, NodeClassification>,
  ownership: Map<GraphNodeId, OwnerResolution>,
): ConnectorExtraction {
  const survivorOf = makeSurvivorResolver(classifications, ownership);

  // Outgoing pathed edges per node (reference/crossStackImport carry
  // propertyPath; dependsOn does not and never resolves an endpoint).
  const pathedEdges = new Map<GraphNodeId, { target: GraphNodeId; propertyPath: string[] }[]>();
  for (const edge of graph.edges) {
    if (edge.kind === 'dependsOn' || edge.source === edge.target) continue;
    const list = pathedEdges.get(edge.source) ?? [];
    list.push({ target: edge.target, propertyPath: edge.propertyPath });
    pathedEdges.set(edge.source, list);
  }

  const edges: ArchEdge[] = [];
  const emitted = new Map<GraphNodeId, boolean>();

  for (const node of graph.nodes) {
    const classification = classifications.get(node.id);
    if (classification?.kind !== 'rule' || classification.role !== 'connector') continue;
    const specs: ConnectorSpec[] =
      classification.rule.connector === undefined
        ? []
        : Array.isArray(classification.rule.connector)
          ? classification.rule.connector
          : [classification.rule.connector];

    const ownerResolution = ownership.get(node.id);
    const ownerId = ownerResolution?.kind === 'resolved' ? ownerResolution.ownerId : undefined;

    /** Resolves one endpoint to zero or more surviving node ids. `principal`/`internet` endpoints are v1-unsupported (spec §8 / Ticket A.9) and resolve to nothing — the connector then degrades, never guesses. */
    const resolveEndpoint = (endpoint: Endpoint): GraphNodeId[] => {
      switch (endpoint.from) {
        case 'owner':
          return ownerId !== undefined ? [ownerId] : [];
        case 'prop': {
          const matches = (pathedEdges.get(node.id) ?? []).filter((e) => pathMatches(endpoint.path, e.propertyPath));
          return [...new Set(matches.map((e) => survivorOf(e.target)))];
        }
        case 'principal':
        case 'internet':
          return [];
      }
    };

    let emittedAny = false;
    specs.forEach((spec, specIndex) => {
      const sources = resolveEndpoint(spec.source);
      const targets = resolveEndpoint(spec.target);
      let pairIndex = 0;
      for (const source of sources) {
        for (const target of targets) {
          if (source === target) continue; // self-edge after survivor mapping — internal, dropped (spec §5 Pass 5)
          edges.push({
            id: `connector:${node.id}:${specIndex}:${pairIndex}`,
            source,
            target,
            kind: spec.kind,
            delivery: spec.delivery ?? inferDeliveryFromPrincipal(node),
            label: spec.label,
            derivedFrom: [
              {
                kind: 'connector',
                viaNodeId: node.id,
                viaResourceType: node.type ?? '(undeclared)',
                file: node.file,
                line: node.pos.line,
              },
            ],
            confidence: 'rule',
            inferred: false,
          });
          pairIndex += 1;
          emittedAny = true;
        }
      }
    });
    emitted.set(node.id, emittedAny);
  }

  return { edges, emitted };
}
