import { describe, expect, test } from 'vitest';
import { loadTemplates } from '../../parser/loader.js';
import { mergeGraphs } from '../../graph/merge.js';
import { classify } from '../classify.js';
import { extractConnectorEdges } from '../connectors.js';
import { resolveOwnership } from '../ownership.js';
import { allExampleFiles, EXAMPLES_DIR } from './corpusHelpers.js';
import type { GraphEdge, ResolvedValue } from '../../common/types.js';
import type { GraphModel, GraphNode } from '../../common/interfaces.js';

/**
 * Ticket A.6 — Pass 4 (connector → edge extraction), run while the full
 * graph is intact. Endpoint resolution rides the GraphModel's existing
 * reference edges (whose `propertyPath` already locates every ref the
 * parser found, including refs nested inside partially-resolved
 * `Fn::Join`/`Fn::Sub` values) — never a naive property traversal, and
 * never an ARN-string guess.
 */

function node(logicalId: string, type: string | undefined, properties?: ResolvedValue): GraphNode {
  return {
    id: `test.yaml#${logicalId}`,
    logicalId,
    type,
    file: 'test.yaml',
    pos: { file: 'test.yaml', line: 1, column: 1 },
    properties,
    inclusion: { kind: 'included' },
  };
}

function refEdge(sourceLogicalId: string, targetLogicalId: string, propertyPath: string[]): GraphEdge {
  return {
    kind: 'reference',
    source: `test.yaml#${sourceLogicalId}`,
    target: `test.yaml#${targetLogicalId}`,
    propertyPath,
    via: { kind: 'ref' },
  };
}

function model(nodes: GraphNode[], edges: GraphEdge[]): GraphModel {
  return { nodes, edges, warnings: [] };
}

function extract(graph: GraphModel) {
  const { classifications } = classify(graph);
  return extractConnectorEdges(graph, classifications, resolveOwnership(graph, classifications));
}

function stringProps(props: Record<string, string>): ResolvedValue {
  return {
    kind: 'object',
    entries: Object.entries(props).map(([key, value]) => ({ key, value: { kind: 'scalar', value } })),
  };
}

describe('extractConnectorEdges — the PO Question 19 wildcard rule (IAM policies)', () => {
  const base = () => [
    node('Fn', 'AWS::Lambda::Function'),
    node('Role', 'AWS::IAM::Role'),
    node('Orders', 'AWS::DynamoDB::Table'),
  ];
  const baseEdges = () => [
    refEdge('Fn', 'Role', ['Role']), // Lambda's execution role — makes Role's owner (and thus the policy's) the Lambda
    refEdge('Policy', 'Role', ['Roles', '0']),
  ];

  test('a specific-ARN policy emits owner → table dataAccess (sync, reads/writes); the wildcard side of the same document emits nothing', () => {
    // The specific statement's Resource ref produced a real graph edge;
    // the wildcard statement ('*') is a literal scalar — no ref, no edge,
    // and therefore no emission. Never guessed from ARN strings.
    const graph = model(
      [...base(), node('Policy', 'AWS::IAM::Policy')],
      [...baseEdges(), refEdge('Policy', 'Orders', ['PolicyDocument', 'Statement', '0', 'Resource'])],
    );
    const { edges } = extract(graph);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      source: 'test.yaml#Fn', // the policy's owner, resolved through the role
      target: 'test.yaml#Orders',
      kind: 'dataAccess',
      label: 'reads/writes',
      delivery: 'sync',
      confidence: 'rule',
      inferred: false,
    });
    expect(edges[0]!.derivedFrom).toEqual([
      expect.objectContaining({ kind: 'connector', viaNodeId: 'test.yaml#Policy', viaResourceType: 'AWS::IAM::Policy' }),
    ]);
  });

  test('a wildcard-only policy emits NO edge but is still absorbed into its owner (visible in the panel, never an edge)', () => {
    const graph = model([...base(), node('Policy', 'AWS::IAM::Policy')], baseEdges());
    const { edges, emitted } = extract(graph);
    expect(edges).toHaveLength(0);
    expect(emitted.get('test.yaml#Policy')).toBe(false);
  });
});

describe('extractConnectorEdges — endpoint failure degrades, never crashes or fabricates', () => {
  test('a connector whose prop endpoints resolve to nothing emits no edges and reports emitted=false (degrades to plain absorbed detail)', () => {
    // An SNS subscription whose Endpoint is a literal email address — no
    // ref, no edge, nothing to point at.
    const graph = model(
      [node('Topic', 'AWS::SNS::Topic'), node('Sub', 'AWS::SNS::Subscription', stringProps({ Endpoint: 'ops@example.com' }))],
      [refEdge('Sub', 'Topic', ['TopicArn'])],
    );
    const { edges, emitted } = extract(graph);
    expect(edges).toHaveLength(0);
    expect(emitted.get('test.yaml#Sub')).toBe(false);
  });

  test('an emitted edge whose endpoints collapse to the same survivor is dropped as a self-edge', () => {
    // A Lambda::Permission whose SourceArn also references the same
    // function: source and target both map to the Lambda.
    const graph = model(
      [node('Fn', 'AWS::Lambda::Function'), node('Perm', 'AWS::Lambda::Permission')],
      [refEdge('Perm', 'Fn', ['FunctionName']), refEdge('Perm', 'Fn', ['SourceArn', '2'])],
    );
    const { edges } = extract(graph);
    expect(edges).toHaveLength(0);
  });
});

describe('extractConnectorEdges — delivery (PO Question 23)', () => {
  test('Lambda::Permission infers delivery from its Principal: apigateway → sync, s3 → async', () => {
    const graphFor = (principal: string) =>
      model(
        [
          node('Fn', 'AWS::Lambda::Function'),
          node('Api', 'AWS::ApiGateway::RestApi'),
          node('Perm', 'AWS::Lambda::Permission', stringProps({ Principal: principal })),
        ],
        [refEdge('Perm', 'Fn', ['FunctionName']), refEdge('Perm', 'Api', ['SourceArn', '3'])],
      );

    const sync = extract(graphFor('apigateway.amazonaws.com'));
    expect(sync.edges[0]).toMatchObject({ source: 'test.yaml#Api', target: 'test.yaml#Fn', label: 'invokes', delivery: 'sync' });

    const async = extract(graphFor('s3.amazonaws.com'));
    expect(async.edges[0]).toMatchObject({ delivery: 'async' });
  });
});

describe('extractConnectorEdges — real fixtures, one per shipped connector type', () => {
  function archFor(files: string[]) {
    const { templates } = loadTemplates(files);
    const graph = mergeGraphs(templates);
    const { classifications } = classify(graph);
    return { graph, extraction: extractConnectorEdges(graph, classifications, resolveOwnership(graph, classifications)) };
  }

  test('ApiGateway::Method + Lambda::Permission (apigateway-lambda-integration): RestApi → Lambda exists as an arch edge but NOT as any direct GraphEdge', () => {
    const FIXTURE = EXAMPLES_DIR + '14-diverse-corpus/apigateway-lambda-integration.yaml';
    const { graph, extraction } = archFor([FIXTURE]);
    const api = `${FIXTURE}#RestApi`;
    const fn = `${FIXTURE}#LambdaFunction`;

    // The AC's core claim: no direct RestApi → LambdaFunction edge exists
    // in the raw graph — the relationship lives only in the Method's
    // Integration.Uri and the Permission's SourceArn.
    expect(graph.edges.some((e) => e.source === api && e.target === fn)).toBe(false);

    const apiToFn = extraction.edges.filter((e) => e.source === api && e.target === fn);
    expect(apiToFn.length).toBeGreaterThanOrEqual(2); // once via the Method, once via the Permission
    const viaTypes = new Set(apiToFn.flatMap((e) => e.derivedFrom.map((p) => p.viaResourceType)));
    expect(viaTypes).toContain('AWS::ApiGateway::Method');
    expect(viaTypes).toContain('AWS::Lambda::Permission');
    expect(apiToFn.every((e) => e.kind === 'invocation' && e.delivery === 'sync')).toBe(true);
  });

  test('ELBv2 listener chain (03-multi-stack-ecs-fargate): LoadBalancer → ECS Service emerges through Listener/ListenerRule → TargetGroup, none of which survive', () => {
    const dir = EXAMPLES_DIR + '03-multi-stack-ecs-fargate/';
    const files = [dir + 'network-stack/template.yaml', dir + 'service-stack/template.yaml', dir + 'private-subnet-public-service/template.yaml'];
    const { extraction } = archFor(files);

    const lbToService = extraction.edges.filter(
      (e) => e.source.includes('LoadBalancer') && e.target.includes('#Service') && e.label === 'forwards to',
    );
    expect(lbToService.length).toBeGreaterThanOrEqual(1);
    expect(lbToService.every((e) => e.delivery === 'sync' && e.kind === 'invocation')).toBe(true);
  });

  test('Lambda::EventSourceMapping (08-cdk-synthesized): emits an async `triggers` edge into a Lambda', () => {
    const { extraction } = archFor([EXAMPLES_DIR + '08-cdk-synthesized/template.json']);
    const triggers = extraction.edges.filter((e) => e.derivedFrom.some((p) => p.viaResourceType === 'AWS::Lambda::EventSourceMapping'));
    expect(triggers.length).toBeGreaterThanOrEqual(1);
    expect(triggers.every((e) => e.label === 'triggers' && e.delivery === 'async' && e.kind === 'invocation')).toBe(true);
  });

  // Events::Rule targets and S3 notification configs are properties of
  // component-role resources, not connector resources — their refs already
  // exist as plain GraphEdges and survive via Pass 5 reparenting (Ticket
  // A.7), so there is deliberately no extraction test for them here.
  // AWS::ApiGatewayV2::Integration has a rule but no fixture on disk
  // exercises it — an A.11 corpus-growth item, recorded, not hidden.

  test('ApiGateway::Authorizer (webapp-solution): RestApi → Cognito UserPool, `authenticates via`, sync', () => {
    const FIXTURE = EXAMPLES_DIR + '14-diverse-corpus/webapp-solution.yaml';
    const { extraction } = archFor([FIXTURE]);
    const viaAuthorizer = extraction.edges.filter((e) => e.derivedFrom.some((p) => p.viaResourceType === 'AWS::ApiGateway::Authorizer'));
    expect(viaAuthorizer).toHaveLength(1);
    expect(viaAuthorizer[0]).toMatchObject({
      source: `${FIXTURE}#RestApi`,
      target: `${FIXTURE}#CognitoUserPool`,
      kind: 'invocation',
      label: 'authenticates via',
      delivery: 'sync',
    });
  });

  test('SecurityGroupIngress across stacks (03): ALB → ECS Service `can reach` emerges from an SG-to-SG rule where BOTH security groups are absorbed', () => {
    const dir = EXAMPLES_DIR + '03-multi-stack-ecs-fargate/';
    const files = [dir + 'network-stack/template.yaml', dir + 'service-stack/template.yaml', dir + 'private-subnet-public-service/template.yaml'];
    const { extraction } = archFor(files);

    // EcsSecurityGroupIngressFromPublicALB: SourceSecurityGroupId → the
    // ALB's SG (absorbed into the ALB), GroupId → the Fargate SG
    // (absorbed into the ECS Service via a cross-stack import edge).
    const network = extraction.edges.filter((e) => e.kind === 'network');
    expect(
      network.some((e) => e.source.includes('#PublicLoadBalancer') && e.target.includes('#Service') && e.label === 'can reach'),
    ).toBe(true);

    // EcsSecurityGroupIngressFromSelf (same SG both sides) must collapse
    // to a self-edge and be dropped — a real-fixture self-edge case.
    expect(extraction.edges.some((e) => e.source === e.target)).toBe(false);
  });

  test('SNS::Subscription to a parameter endpoint (sns-topic): degrades — Endpoint is a Ref to a Parameter, not a resource, so nothing is fabricated', () => {
    const FIXTURE = EXAMPLES_DIR + '14-diverse-corpus/sns-topic.yaml';
    const { extraction } = archFor([FIXTURE]);
    expect(extraction.emitted.get(`${FIXTURE}#SNSSubscription`)).toBe(false);
    expect(extraction.edges.filter((e) => e.derivedFrom.some((p) => p.viaResourceType === 'AWS::SNS::Subscription'))).toHaveLength(0);
  });

  test('S3::BucketPolicy (s3-compliant-bucket): principal endpoints are v1-unsupported — degrades to absorbed detail, no guessed edge', () => {
    const FIXTURE = EXAMPLES_DIR + '14-diverse-corpus/s3-compliant-bucket.yaml';
    const { graph, extraction } = archFor([FIXTURE]);
    const policies = graph.nodes.filter((n) => n.type === 'AWS::S3::BucketPolicy');
    expect(policies.length).toBeGreaterThan(0);
    for (const policy of policies) {
      expect(extraction.emitted.get(policy.id)).toBe(false);
    }
  });

  test('cfngoat wildcard IAM policies (PO Question 19 on a real template): EC2Policy grants s3:*/ec2:* on Resource "*" — zero edges emitted from it', () => {
    const FIXTURE = EXAMPLES_DIR + '07-vulnerable-cfngoat/cfngoat.yaml';
    const { extraction } = archFor([FIXTURE]);
    expect(extraction.edges.filter((e) => e.derivedFrom.some((p) => p.viaNodeId === `${FIXTURE}#EC2Policy`))).toHaveLength(0);
    expect(extraction.emitted.get(`${FIXTURE}#EC2Policy`)).toBe(false);
  });

  test('whole-corpus extraction invariants: every connector node accounted for in `emitted`; every edge connects surviving endpoints; no self-edges anywhere', () => {
    const { templates } = loadTemplates(allExampleFiles());
    const graph = mergeGraphs(templates);
    const { classifications } = classify(graph);
    const ownership = resolveOwnership(graph, classifications);
    const extraction = extractConnectorEdges(graph, classifications, ownership);

    const connectorNodes = graph.nodes.filter((n) => {
      const c = classifications.get(n.id);
      return c?.kind === 'rule' && c.role === 'connector';
    });
    expect(connectorNodes.length).toBeGreaterThan(10); // the corpus genuinely exercises connectors at scale
    expect(extraction.emitted.size).toBe(connectorNodes.length);

    // Endpoints must be survivors: never an absorbed detail or a
    // connector that vanishes.
    const isAbsorbableWithOwner = (id: string) => {
      const c = classifications.get(id);
      const absorbable = c?.kind === 'heuristic' || (c?.kind === 'rule' && (c.role === 'detail' || c.role === 'connector'));
      return absorbable && ownership.get(id)?.kind === 'resolved';
    };
    for (const edge of extraction.edges) {
      expect(edge.source).not.toBe(edge.target);
      expect(isAbsorbableWithOwner(edge.source), `edge source ${edge.source} does not survive`).toBe(false);
      expect(isAbsorbableWithOwner(edge.target), `edge target ${edge.target} does not survive`).toBe(false);
    }
    // And extraction is doing real work at corpus scale.
    expect(extraction.edges.length).toBeGreaterThan(10);
  });
});
