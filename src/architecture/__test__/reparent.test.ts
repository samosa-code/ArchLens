import { describe, expect, test } from 'vitest';
import { loadTemplates } from '../../parser/loader.js';
import { mergeGraphs } from '../../graph/merge.js';
import { classify } from '../classify.js';
import { extractConnectorEdges } from '../connectors.js';
import { resolveOwnership } from '../ownership.js';
import { reparentAndDedupe } from '../reparent.js';
import { generate } from '../generate.js';
import { allExampleFiles, EXAMPLES_DIR } from './corpusHelpers.js';
import type { GraphEdge, ResolvedValue } from '../../common/types.js';
import type { GraphModel, GraphNode } from '../../common/interfaces.js';

/**
 * Ticket A.7 — Pass 5: reparent every original GraphEdge onto surviving
 * owners, drop internal/self edges, containment for container endpoints,
 * then dedupe by (source, target, kind) with derivedFrom UNION — never
 * discard (the dagre-multigraph lesson, applied deliberately).
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

function refEdge(sourceLogicalId: string, targetLogicalId: string, propertyPath: string[] = ['X']): GraphEdge {
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

function run(graph: GraphModel) {
  const { classifications } = classify(graph);
  const ownership = resolveOwnership(graph, classifications);
  const extraction = extractConnectorEdges(graph, classifications, ownership);
  return reparentAndDedupe(graph, classifications, ownership, extraction);
}

describe('reparentAndDedupe — the spec §5 table, one test per row', () => {
  // Shared shape: Fn (component) — Role (detail, absorbs into Fn);
  // Queue (component) stands alone.
  const fn = () => node('Fn', 'AWS::Lambda::Function');
  const role = () => node('Role', 'AWS::IAM::Role');
  const queue = () => node('Queue', 'AWS::SQS::Queue');

  test('row 1 — A → X with X absorbed into O: becomes A → O', () => {
    const graph = model(
      [fn(), role(), queue()],
      [refEdge('Fn', 'Role'), refEdge('Queue', 'Role')], // Queue → Role: Role is absorbed into Fn
    );
    const { edges } = run(graph);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: 'test.yaml#Queue', target: 'test.yaml#Fn', kind: 'association' });
  });

  test('row 2 — X → B with X absorbed into O: becomes O → B', () => {
    const graph = model(
      [fn(), role(), queue()],
      [refEdge('Fn', 'Role'), refEdge('Role', 'Queue')],
    );
    const { edges } = run(graph);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: 'test.yaml#Fn', target: 'test.yaml#Queue', kind: 'association' });
  });

  test('rows 3 & 5 — X → Y both absorbed into the same owner (internal), and a literal self-edge: both dropped', () => {
    // Alias → Version, both absorbed into the same Fn; plus Fn → Fn.
    const graph = model(
      [fn(), node('Alias', 'AWS::Lambda::Alias'), node('Version', 'AWS::Lambda::Version')],
      [refEdge('Alias', 'Fn'), refEdge('Version', 'Fn'), refEdge('Alias', 'Version'), refEdge('Fn', 'Fn')],
    );
    expect(run(graph).edges).toHaveLength(0);
  });

  test('row 4 — X → Y absorbed into different owners O1, O2: becomes O1 → O2', () => {
    // RoleA absorbed into FnA, RoleB absorbed into FnB, RoleA → RoleB.
    const graph = model(
      [
        node('FnA', 'AWS::Lambda::Function'),
        node('FnB', 'AWS::Lambda::Function'),
        node('RoleA', 'AWS::IAM::Role'),
        node('RoleB', 'AWS::IAM::Role'),
      ],
      [refEdge('FnA', 'RoleA'), refEdge('FnB', 'RoleB'), refEdge('RoleA', 'RoleB')],
    );
    const { edges } = run(graph);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: 'test.yaml#FnA', target: 'test.yaml#FnB', kind: 'association' });
  });

  test('row 6 — a container endpoint becomes `containment` (nesting, not an arrow)', () => {
    const graph = model(
      [node('Vpc', 'AWS::EC2::VPC'), node('Sub', 'AWS::EC2::Subnet'), node('Server', 'AWS::EC2::Instance')],
      [refEdge('Sub', 'Vpc'), refEdge('Server', 'Sub')],
    );
    const { edges } = run(graph);
    expect(edges).toHaveLength(2);
    expect(edges.every((e) => e.kind === 'containment')).toBe(true);
  });

  test('dedupe — two references between the same surviving pair collapse to ONE edge whose derivedFrom is the UNION of both', () => {
    const graph = model(
      [fn(), node('Table', 'AWS::DynamoDB::Table')],
      [refEdge('Fn', 'Table', ['Environment', 'Variables', 'TABLE']), refEdge('Fn', 'Table', ['SomeOtherProp'])],
    );
    const { edges } = run(graph);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.derivedFrom).toHaveLength(2);
  });

  test('an emitted connector\'s own reference edges are skipped — its semantics already live in the extracted edge (no duplicate association arrow)', () => {
    // Permission emits Api → Fn; its raw refs (FunctionName, SourceArn)
    // must NOT also reparent into Fn → Api / Api → Fn associations.
    const graph = model(
      [fn(), node('Api', 'AWS::ApiGateway::RestApi'), node('Perm', 'AWS::Lambda::Permission', { kind: 'object', entries: [{ key: 'Principal', value: { kind: 'scalar', value: 'apigateway.amazonaws.com' } }] })],
      [refEdge('Perm', 'Fn', ['FunctionName']), refEdge('Perm', 'Api', ['SourceArn', '3'])],
    );
    const { edges } = run(graph);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: 'test.yaml#Api', target: 'test.yaml#Fn', kind: 'invocation', label: 'invokes' });
  });

  test('a DEGRADED connector (no edges emitted) keeps its reference edges, reparented like any detail\'s', () => {
    // A subscription whose Endpoint never resolves: absorbed into Topic;
    // its TopicArn ref collapses internally — but a ref from a THIRD node
    // to the subscription reparents onto the topic.
    const graph = model(
      [node('Topic', 'AWS::SNS::Topic'), node('Sub', 'AWS::SNS::Subscription'), queue()],
      [refEdge('Sub', 'Topic', ['TopicArn']), refEdge('Queue', 'Sub')],
    );
    const { edges } = run(graph);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: 'test.yaml#Queue', target: 'test.yaml#Topic', kind: 'association' });
  });

  test('dependsOn edges reparent too, carrying dependsOn provenance', () => {
    const graph = model(
      [fn(), queue()],
      [{ kind: 'dependsOn', source: 'test.yaml#Fn', target: 'test.yaml#Queue' }],
    );
    const { edges } = run(graph);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.derivedFrom[0]).toMatchObject({ kind: 'dependsOn' });
  });

  test('nodeIndex — every graph node maps to its surviving arch element: absorbed → owner, kept → self, container → itself', () => {
    const graph = model(
      [fn(), role(), node('Vpc', 'AWS::EC2::VPC')],
      [refEdge('Fn', 'Role')],
    );
    const { nodeIndex } = run(graph);
    expect(nodeIndex['test.yaml#Fn']).toBe('test.yaml#Fn');
    expect(nodeIndex['test.yaml#Role']).toBe('test.yaml#Fn');
    expect(nodeIndex['test.yaml#Vpc']).toBe('test.yaml#Vpc');
    expect(Object.keys(nodeIndex)).toHaveLength(3);
  });
});

describe('reparentAndDedupe — real fixtures', () => {
  test('apigateway-lambda-integration: Method + Permission collapse into ONE RestApi → Lambda invocation edge whose derivedFrom carries BOTH provenances', () => {
    const FIXTURE = EXAMPLES_DIR + '14-diverse-corpus/apigateway-lambda-integration.yaml';
    const { templates } = loadTemplates([FIXTURE]);
    const arch = generate(mergeGraphs(templates));

    const apiToFn = arch.edges.filter((e) => e.source === `${FIXTURE}#RestApi` && e.target === `${FIXTURE}#LambdaFunction`);
    expect(apiToFn).toHaveLength(1); // deduped — not two parallel arrows
    const viaTypes = new Set(apiToFn[0]!.derivedFrom.map((p) => p.viaResourceType));
    expect(viaTypes).toContain('AWS::ApiGateway::Method');
    expect(viaTypes).toContain('AWS::Lambda::Permission');
    expect(apiToFn[0]!.kind).toBe('invocation');
    // No leftover unlabeled association arrow between the same pair.
    expect(arch.edges.filter((e) => e.source === `${FIXTURE}#RestApi` && e.target === `${FIXTURE}#LambdaFunction` && e.kind === 'association')).toHaveLength(0);
  });

  test('09-sam: the Lambda\'s DynamoDB reference survives as a Function → Table association (property-derived edges reach the diagram)', () => {
    const FIXTURE = EXAMPLES_DIR + '09-sam-apigw-lambda-dynamodb/template.yaml';
    const { templates } = loadTemplates([FIXTURE]);
    const arch = generate(mergeGraphs(templates));
    expect(
      arch.edges.some((e) => e.source.endsWith('#PutItemsFunction') && e.target.endsWith('#Users') && e.kind === 'association'),
    ).toBe(true);
  });

  test('whole corpus: edges reference only surviving elements, no self-edges, (source,target,kind) unique, nodeIndex total and closed', () => {
    const { templates } = loadTemplates(allExampleFiles());
    const graph = mergeGraphs(templates);
    const arch = generate(graph);

    const survivorIds = new Set([...arch.nodes.map((n) => n.id), ...arch.containers.map((c) => c.id)]);
    const seen = new Set<string>();
    for (const edge of arch.edges) {
      expect(edge.source).not.toBe(edge.target);
      expect(survivorIds.has(edge.source), `edge source ${edge.source} does not survive`).toBe(true);
      expect(survivorIds.has(edge.target), `edge target ${edge.target} does not survive`).toBe(true);
      const key = `${edge.source}→${edge.target}:${edge.kind}`;
      expect(seen.has(key), `duplicate (source,target,kind): ${key}`).toBe(false);
      seen.add(key);
      expect(edge.derivedFrom.length).toBeGreaterThan(0);
    }

    // nodeIndex: one entry per source node, every value a survivor.
    expect(Object.keys(arch.nodeIndex)).toHaveLength(graph.nodes.length);
    for (const target of Object.values(arch.nodeIndex)) {
      expect(survivorIds.has(target), `nodeIndex target ${target} does not survive`).toBe(true);
    }
  });
});
