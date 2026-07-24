/**
 * Synthetic nodes (Ticket A.9, spec §8): a single `Internet` / `Users`
 * node, emitted only when at least one real ingress signal is found —
 * never presented as template-derived (`node.inferred`/`edge.inferred`
 * are both `true`, and the node's own `decision.action` is `'synthetic'`).
 *
 * Two independent detection paths, because real templates express public
 * ingress two different ways:
 *
 *   1. `0.0.0.0/0`/`::/0` ingress, either as a standalone
 *      `AWS::EC2::SecurityGroupIngress` resource's `CidrIp`/`CidrIpv6`
 *      property, or as an entry in an `AWS::EC2::SecurityGroup`'s own
 *      *inline* `SecurityGroupIngress` property list (the common
 *      `examples/03-multi-stack-ecs-fargate` pattern — the SG resource
 *      carries its own rules, no separate Ingress resource exists at all).
 *      This is deliberately independent of Pass 4's connector mechanism:
 *      `AWS::EC2::SecurityGroup` is a `detail`, not a `connector`, so its
 *      inline rules are invisible to `connectors.ts` entirely.
 *   2. Managed edge services that are public *by default*: CloudFront
 *      unconditionally; API Gateway (REST/HTTP/V2/SAM) unless it declares
 *      a `PRIVATE` `EndpointConfiguration` — these have no security group
 *      at all in `examples/09-sam-apigw-lambda-dynamodb`, so path 1 alone
 *      would miss them.
 *
 * Both paths resolve their target through the already-finalized
 * `nodeIndex` (Pass 5/6's output) — never re-deriving ownership.
 */
import type { GraphModel, GraphNode } from '../common/interfaces.js';
import type { GraphNodeId, ResolvedValue } from '../common/types.js';
import type { AbstractionDecision, ArchEdge, ArchNode, EdgeProvenance } from './types.js';

export const SYNTHETIC_INTERNET_ID = 'synthetic:internet-users';

const PUBLIC_BY_DEFAULT_TYPES = new Set([
  'AWS::CloudFront::Distribution',
  'AWS::ApiGateway::RestApi',
  'AWS::ApiGatewayV2::Api',
  'AWS::Serverless::Api',
  'AWS::Serverless::HttpApi',
]);

function isPublicCidr(value: unknown): boolean {
  return value === '0.0.0.0/0' || value === '::/0';
}

/** The node's own top-level property `key`, unresolved (returned as-is — callers inspect its `kind`). */
function prop(node: GraphNode, key: string): ResolvedValue | undefined {
  const props = node.properties;
  if (props?.kind !== 'object') return undefined;
  return props.entries.find((e) => e.key === key)?.value;
}

/** True if any object in a resolved `list` has a `CidrIp`/`CidrIpv6` entry equal to a public CIDR. */
function listHasPublicIngress(list: ResolvedValue): boolean {
  if (list.kind !== 'list') return false;
  return list.items.some((item) => {
    if (item.kind !== 'object') return false;
    const cidr = item.entries.find((e) => e.key === 'CidrIp' || e.key === 'CidrIpv6')?.value;
    return cidr?.kind === 'scalar' && isPublicCidr(cidr.value);
  });
}

/** A standalone `SecurityGroupIngress`/inline `SecurityGroup` rule is public if its own CidrIp/CidrIpv6 (scalar props, or the inline list's entries) is `0.0.0.0/0`/`::/0`. */
function hasPublicIngress(node: GraphNode): boolean {
  if (node.type === 'AWS::EC2::SecurityGroupIngress') {
    const cidrIp = prop(node, 'CidrIp');
    const cidrIpv6 = prop(node, 'CidrIpv6');
    return (cidrIp?.kind === 'scalar' && isPublicCidr(cidrIp.value)) || (cidrIpv6?.kind === 'scalar' && isPublicCidr(cidrIpv6.value));
  }
  if (node.type === 'AWS::EC2::SecurityGroup') {
    const inline = prop(node, 'SecurityGroupIngress');
    return inline !== undefined && listHasPublicIngress(inline);
  }
  return false;
}

/** True if a public-by-default type (CloudFront, API Gateway) has NOT been explicitly configured private via `EndpointConfiguration`. */
function isPubliclyReachableByDefault(node: GraphNode): boolean {
  if (node.type === undefined || !PUBLIC_BY_DEFAULT_TYPES.has(node.type)) return false;
  const config = prop(node, 'EndpointConfiguration');
  if (config === undefined) return true; // no configuration declared -> the service default, which is public
  if (config.kind === 'scalar') return config.value !== 'PRIVATE'; // SAM shorthand: EndpointConfiguration: REGIONAL|EDGE|PRIVATE
  if (config.kind === 'object') {
    const types = config.entries.find((e) => e.key === 'Types' || e.key === 'Type')?.value;
    if (types?.kind === 'scalar') return types.value !== 'PRIVATE';
    if (types?.kind === 'list') return !types.items.some((t) => t.kind === 'scalar' && t.value === 'PRIVATE');
  }
  return true;
}

export interface SyntheticResult {
  /** Present only when at least one public ingress path was found. */
  node?: ArchNode;
  edges: ArchEdge[];
}

export function addSyntheticNodes(graph: GraphModel, nodeIndex: Record<GraphNodeId, string>): SyntheticResult {
  const provenanceByTarget = new Map<string, EdgeProvenance[]>();

  const record = (trigger: GraphNode, target: GraphNodeId): void => {
    const list = provenanceByTarget.get(target) ?? [];
    list.push({ kind: 'synthetic', viaNodeId: trigger.id, viaResourceType: trigger.type ?? '(undeclared)', file: trigger.file, line: trigger.pos.line });
    provenanceByTarget.set(target, list);
  };

  for (const n of graph.nodes) {
    if (hasPublicIngress(n) || isPubliclyReachableByDefault(n)) {
      const target = nodeIndex[n.id];
      if (target !== undefined) record(n, target);
    }
  }

  if (provenanceByTarget.size === 0) return { edges: [] };

  const decision: AbstractionDecision = {
    nodeId: SYNTHETIC_INTERNET_ID,
    action: 'synthetic',
    rule: 'synthetic:internet-users',
    reason: 'Emitted because at least one public ingress path (0.0.0.0/0 security group rule, or a public-by-default edge service) was detected — not present in any template.',
    confidence: 'rule',
  };
  const node: ArchNode = {
    id: SYNTHETIC_INTERNET_ID,
    label: 'Internet / Users',
    service: 'internet',
    resourceType: 'Synthetic::InternetUsers',
    layer: 'edge',
    sourceNodeId: SYNTHETIC_INTERNET_ID,
    absorbed: [],
    decision,
    badges: [],
    inferred: true,
  };

  const edges: ArchEdge[] = [...provenanceByTarget.entries()].map(([target, derivedFrom]) => ({
    id: `synthetic:${SYNTHETIC_INTERNET_ID}->${target}`,
    source: SYNTHETIC_INTERNET_ID,
    target,
    kind: 'network',
    delivery: 'sync',
    label: 'can reach',
    derivedFrom,
    confidence: 'rule',
    inferred: true,
  }));

  return { node, edges };
}
