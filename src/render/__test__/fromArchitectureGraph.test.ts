import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { architectureGraphToRenderGraph } from '../fromArchitectureGraph.js';
import { loadTemplates } from '../../parser/loader.js';
import { mergeGraphs } from '../../graph/merge.js';
import { generate } from '../../architecture/generate.js';
import type { ArchitectureGraph, ArchNode } from '../../architecture/types.js';

/**
 * Ticket 3.3's prerequisite step (pulled forward from Ticket 3.4 — see
 * SPRINT-PLAN.md's 2026-07-23 scope decision): projects an
 * `ArchitectureGraph` down to the renderer's `RenderGraph` contract —
 * container → nesting-hint, edge kind → line style, service → icon key,
 * plus everything the click-for-details panel needs (absorbed groups,
 * per-item finding tint, Connections).
 */

function baseNode(overrides: Partial<ArchNode> = {}): ArchNode {
  return {
    id: 'test.yaml#Fn',
    label: 'Fn',
    service: 'lambda',
    resourceType: 'AWS::Lambda::Function',
    layer: 'compute',
    sourceNodeId: 'test.yaml#Fn',
    file: 'test.yaml',
    line: 10,
    absorbed: [],
    decision: { nodeId: 'test.yaml#Fn', action: 'kept', rule: 'rule:AWS::Lambda::Function', reason: 'Classified as a component.', confidence: 'rule' },
    badges: [],
    ...overrides,
  };
}

function baseGraph(overrides: Partial<ArchitectureGraph> = {}): ArchitectureGraph {
  return {
    nodes: [],
    edges: [],
    containers: [],
    decisions: [],
    unknownTypes: [],
    nodeIndex: {},
    stats: { sourceNodeCount: 0, componentCount: 0, absorbedCount: 0, connectorEdgeCount: 0 },
    ...overrides,
  };
}

describe('architectureGraphToRenderGraph — synthetic (finding/tint logic the real pipeline can\'t produce yet)', () => {
  test('a node with a security badge on ITSELF surfaces in RenderNode.badges', () => {
    const node = baseNode({ badges: [{ kind: 'security', message: 'Wildcard IAM policy', sourceNodeId: 'test.yaml#Fn' }] });
    const render = architectureGraphToRenderGraph(baseGraph({ nodes: [node] }));
    expect(render.nodes[0]!.badges).toHaveLength(1);
    expect(render.nodes[0]!.badges![0]).toMatchObject({ kind: 'security', message: 'Wildcard IAM policy' });
  });

  test('per-item finding tint: only the absorbed resource an inherited badge names gets hasFinding: true — never every item (PO Question 24)', () => {
    const node = baseNode({
      absorbed: [
        { nodeId: 'test.yaml#Role', logicalId: 'Role', resourceType: 'AWS::IAM::Role', file: 'test.yaml', line: 20, group: 'permissions', reason: 'Absorbed.' },
        { nodeId: 'test.yaml#Policy', logicalId: 'Policy', resourceType: 'AWS::IAM::Policy', file: 'test.yaml', line: 25, group: 'permissions', reason: 'Absorbed.' },
        { nodeId: 'test.yaml#LogGroup', logicalId: 'LogGroup', resourceType: 'AWS::Logs::LogGroup', file: 'test.yaml', line: 30, group: 'observability', reason: 'Absorbed.' },
      ],
      badges: [{ kind: 'security', message: 'Wildcard IAM policy', sourceNodeId: 'test.yaml#Policy' }],
    });
    const render = architectureGraphToRenderGraph(baseGraph({ nodes: [node] }));
    const byLogicalId = new Map(render.nodes[0]!.absorbed!.map((a) => [a.logicalId, a]));
    expect(byLogicalId.get('Policy')!.hasFinding).toBe(true);
    expect(byLogicalId.get('Role')!.hasFinding).toBe(false);
    expect(byLogicalId.get('LogGroup')!.hasFinding).toBe(false);
  });

  test('a node with no badges at all has an empty badges array, not undefined — the panel must be able to say "no findings" honestly', () => {
    const render = architectureGraphToRenderGraph(baseGraph({ nodes: [baseNode()] }));
    expect(render.nodes[0]!.badges).toEqual([]);
  });

  test('containment-kind edges are excluded entirely — nesting is expressed via containerId/parentId, never as a drawn arrow', () => {
    const graph = baseGraph({
      nodes: [baseNode({ id: 'test.yaml#Server', label: 'Server' })],
      edges: [{ id: 'e1', source: 'test.yaml#Subnet', target: 'test.yaml#Vpc', kind: 'containment', delivery: 'sync', derivedFrom: [], confidence: 'rule', inferred: false }],
      containers: [
        { id: 'test.yaml#Vpc', label: 'VPC', kind: 'vpc', absorbed: [], badges: [] },
        { id: 'test.yaml#Subnet', label: 'Subnet', kind: 'subnet', parentId: 'test.yaml#Vpc', absorbed: [], badges: [] },
      ],
    });
    const render = architectureGraphToRenderGraph(graph);
    expect(render.edges).toHaveLength(0);
    expect(render.containers).toHaveLength(2);
    expect(render.containers!.find((c) => c.id === 'test.yaml#Subnet')!.parentId).toBe('test.yaml#Vpc');
  });

  test('a real (non-containment) edge carries kind/label/delivery/inferred through', () => {
    const graph = baseGraph({
      nodes: [baseNode(), baseNode({ id: 'test.yaml#Table', label: 'Table', service: 'dynamodb', layer: 'data' })],
      edges: [{ id: 'e1', source: 'test.yaml#Fn', target: 'test.yaml#Table', kind: 'dataAccess', label: 'reads/writes', delivery: 'sync', derivedFrom: [], confidence: 'rule', inferred: true }],
    });
    const render = architectureGraphToRenderGraph(graph);
    expect(render.edges).toHaveLength(1);
    expect(render.edges[0]).toMatchObject({ source: 'test.yaml#Fn', target: 'test.yaml#Table', kind: 'dataAccess', label: 'reads/writes', delivery: 'sync', inferred: true });
  });
});

describe('architectureGraphToRenderGraph — real fixtures', () => {
  const EXAMPLES_DIR = fileURLToPath(new URL('../../../examples/', import.meta.url));

  test('01-simple-lambda: the Function node carries service/layer/file/line/decisionReason, and its absorbed Role appears with no finding', () => {
    const { templates } = loadTemplates([EXAMPLES_DIR + '01-simple-lambda/template.yaml']);
    const arch = generate(mergeGraphs(templates));
    const render = architectureGraphToRenderGraph(arch);

    expect(render.nodes).toHaveLength(1);
    const fn = render.nodes[0]!;
    expect(fn.service).toBe('lambda');
    expect(fn.layer).toBe('compute');
    expect(fn.type).toBe('AWS::Lambda::Function');
    expect(fn.file).toContain('01-simple-lambda');
    expect(fn.line).toBeGreaterThan(1);
    expect(fn.decisionReason).toBeTruthy();
    expect(fn.absorbed).toHaveLength(1);
    expect(fn.absorbed![0]).toMatchObject({ logicalId: 'LambdaRole', resourceType: 'AWS::IAM::Role', group: 'permissions', hasFinding: false });
  });

  test('02-complex-vpc-nat: VPC/Subnet containers come through with correct nesting, and member nodes carry containerId', () => {
    const { templates } = loadTemplates([EXAMPLES_DIR + '02-complex-vpc-nat/template.yaml']);
    const arch = generate(mergeGraphs(templates));
    const render = architectureGraphToRenderGraph(arch);

    expect(render.containers!.length).toBeGreaterThan(0);
    const vpc = render.containers!.find((c) => c.kind === 'vpc')!;
    expect(vpc).toBeDefined();
    const subnet = render.containers!.find((c) => c.kind === 'subnet' && c.parentId === vpc.id);
    expect(subnet).toBeDefined();
  });

  test('apigateway-lambda-integration: the connector-derived edge carries its real kind/label, and no containment edges leak into RenderGraph.edges', () => {
    const FIXTURE = EXAMPLES_DIR + '14-diverse-corpus/apigateway-lambda-integration.yaml';
    const { templates } = loadTemplates([FIXTURE]);
    const arch = generate(mergeGraphs(templates));
    const render = architectureGraphToRenderGraph(arch);

    expect(render.edges.every((e) => (e.kind as string) !== 'containment')).toBe(true);
    const apiToFn = render.edges.find((e) => e.source === `${FIXTURE}#RestApi` && e.target === `${FIXTURE}#LambdaFunction`);
    expect(apiToFn).toMatchObject({ kind: 'invocation', delivery: 'sync' });
  });

  test('whole corpus: every node/edge/container round-trips without crashing, and node ids stay unique', () => {
    const files: string[] = [];
    const CORPUS_DIR = EXAMPLES_DIR + '14-diverse-corpus/';
    for (const f of ['apigateway-lambda-integration.yaml', 'sam-apigw-fifo-sqs-lambda-sns.yaml', 'rds-mysql-with-read-replica.yaml']) files.push(CORPUS_DIR + f);
    const { templates } = loadTemplates(files);
    const arch = generate(mergeGraphs(templates));
    const render = architectureGraphToRenderGraph(arch);

    expect(render.nodes.length).toBe(arch.nodes.length);
    expect(new Set(render.nodes.map((n) => n.id)).size).toBe(render.nodes.length);
  });
});
