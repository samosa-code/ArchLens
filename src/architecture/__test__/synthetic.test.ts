import { describe, expect, test } from 'vitest';
import { addSyntheticNodes, SYNTHETIC_INTERNET_ID } from '../synthetic.js';
import { generate } from '../generate.js';
import { loadTemplates } from '../../parser/loader.js';
import { mergeGraphs } from '../../graph/merge.js';
import { fileURLToPath } from 'node:url';
import type { ResolvedValue } from '../../common/types.js';
import type { GraphModel, GraphNode } from '../../common/interfaces.js';

/**
 * Ticket A.9 — synthetic `Internet`/`Users` node (spec §8): emitted when
 * any ingress path from `0.0.0.0/0`/`::/0` reaches a component, OR the
 * component is one of the managed edge services that's public by default
 * (CloudFront always; API Gateway unless explicitly configured PRIVATE).
 * Never template-derived — `node.inferred`/`edge.inferred` are both `true`,
 * and the node's own `decision` explains it without polluting the
 * corpus-wide `decisions` audit log (it has no source GraphModel node).
 */

function node(logicalId: string, type: string, properties?: ResolvedValue): GraphNode {
  return {
    id: `test.yaml#${logicalId}`,
    logicalId,
    type,
    file: 'test.yaml',
    pos: { file: 'test.yaml', line: 7, column: 1 },
    properties,
    inclusion: { kind: 'included' },
  };
}

function model(nodes: GraphNode[]): GraphModel {
  return { nodes, edges: [], warnings: [] };
}

function identityIndex(nodes: GraphNode[]): Record<string, string> {
  return Object.fromEntries(nodes.map((n) => [n.id, n.id]));
}

function scalar(value: string): ResolvedValue {
  return { kind: 'scalar', value };
}
function obj(entries: { key: string; value: ResolvedValue }[]): ResolvedValue {
  return { kind: 'object', entries };
}
function list(items: ResolvedValue[]): ResolvedValue {
  return { kind: 'list', items };
}

describe('addSyntheticNodes — ingress detection (unit)', () => {
  test('standalone SecurityGroupIngress with CidrIp 0.0.0.0/0 reaches its resolved owner', () => {
    const ingress = node('PublicIngress', 'AWS::EC2::SecurityGroupIngress', obj([{ key: 'CidrIp', value: scalar('0.0.0.0/0') }]));
    const owner = node('Alb', 'AWS::ElasticLoadBalancingV2::LoadBalancer');
    const graph = model([ingress, owner]);
    const nodeIndex = { ...identityIndex(graph.nodes), [ingress.id]: owner.id };

    const result = addSyntheticNodes(graph, nodeIndex);
    expect(result.node).toBeDefined();
    expect(result.node!.id).toBe(SYNTHETIC_INTERNET_ID);
    expect(result.node!.inferred).toBe(true);
    expect(result.node!.layer).toBe('edge');
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toMatchObject({ source: SYNTHETIC_INTERNET_ID, target: owner.id, kind: 'network', inferred: true });
    expect(result.edges[0]!.derivedFrom[0]).toMatchObject({ kind: 'synthetic', viaNodeId: ingress.id, viaResourceType: 'AWS::EC2::SecurityGroupIngress' });
  });

  test('CidrIpv6 ::/0 is public too', () => {
    const ingress = node('PublicIngress6', 'AWS::EC2::SecurityGroupIngress', obj([{ key: 'CidrIpv6', value: scalar('::/0') }]));
    const owner = node('Alb', 'AWS::ElasticLoadBalancingV2::LoadBalancer');
    const graph = model([ingress, owner]);
    const nodeIndex = { ...identityIndex(graph.nodes), [ingress.id]: owner.id };

    const result = addSyntheticNodes(graph, nodeIndex);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]!.target).toBe(owner.id);
  });

  test('a private CidrIp (10.0.0.0/8) never triggers the synthetic node', () => {
    const ingress = node('PrivateIngress', 'AWS::EC2::SecurityGroupIngress', obj([{ key: 'CidrIp', value: scalar('10.0.0.0/8') }]));
    const owner = node('Alb', 'AWS::ElasticLoadBalancingV2::LoadBalancer');
    const graph = model([ingress, owner]);
    const nodeIndex = { ...identityIndex(graph.nodes), [ingress.id]: owner.id };

    const result = addSyntheticNodes(graph, nodeIndex);
    expect(result.node).toBeUndefined();
    expect(result.edges).toHaveLength(0);
  });

  test('a SecurityGroupIngress with only SourceSecurityGroupId (SG-to-SG, no CIDR) never triggers it', () => {
    const ingress = node('SgToSg', 'AWS::EC2::SecurityGroupIngress', obj([{ key: 'SourceSecurityGroupId', value: scalar('sg-123') }]));
    const owner = node('Alb', 'AWS::ElasticLoadBalancingV2::LoadBalancer');
    const graph = model([ingress, owner]);
    const nodeIndex = { ...identityIndex(graph.nodes), [ingress.id]: owner.id };

    const result = addSyntheticNodes(graph, nodeIndex);
    expect(result.edges).toHaveLength(0);
  });

  test('inline SecurityGroupIngress list on the SecurityGroup resource itself (no standalone Ingress resource) is detected', () => {
    const sg = node(
      'PublicSg',
      'AWS::EC2::SecurityGroup',
      obj([{ key: 'SecurityGroupIngress', value: list([obj([{ key: 'CidrIp', value: scalar('0.0.0.0/0') }])]) }]),
    );
    const owner = node('Alb', 'AWS::ElasticLoadBalancingV2::LoadBalancer');
    const graph = model([sg, owner]);
    const nodeIndex = { ...identityIndex(graph.nodes), [sg.id]: owner.id };

    const result = addSyntheticNodes(graph, nodeIndex);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toMatchObject({ source: SYNTHETIC_INTERNET_ID, target: owner.id });
    expect(result.edges[0]!.derivedFrom[0]).toMatchObject({ viaNodeId: sg.id, viaResourceType: 'AWS::EC2::SecurityGroup' });
  });

  test('inline SecurityGroupIngress list with only private CIDRs never triggers it', () => {
    const sg = node(
      'PrivateSg',
      'AWS::EC2::SecurityGroup',
      obj([{ key: 'SecurityGroupIngress', value: list([obj([{ key: 'CidrIp', value: scalar('10.0.0.0/16') }])]) }]),
    );
    const graph = model([sg]);
    const result = addSyntheticNodes(graph, identityIndex(graph.nodes));
    expect(result.edges).toHaveLength(0);
  });

  test('CloudFront::Distribution is always public, no property needed', () => {
    const cf = node('Cdn', 'AWS::CloudFront::Distribution');
    const graph = model([cf]);
    const result = addSyntheticNodes(graph, identityIndex(graph.nodes));
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toMatchObject({ target: cf.id });
  });

  test('AWS::ApiGateway::RestApi is public by default (no EndpointConfiguration)', () => {
    const api = node('Api', 'AWS::ApiGateway::RestApi');
    const graph = model([api]);
    const result = addSyntheticNodes(graph, identityIndex(graph.nodes));
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]!.target).toBe(api.id);
  });

  test('AWS::ApiGateway::RestApi with EndpointConfiguration.Types: [PRIVATE] is NOT public', () => {
    const api = node('Api', 'AWS::ApiGateway::RestApi', obj([{ key: 'EndpointConfiguration', value: obj([{ key: 'Types', value: list([scalar('PRIVATE')]) }]) }]));
    const graph = model([api]);
    const result = addSyntheticNodes(graph, identityIndex(graph.nodes));
    expect(result.edges).toHaveLength(0);
  });

  test('AWS::Serverless::Api with a REGIONAL string EndpointConfiguration (SAM shorthand) is public', () => {
    const api = node('Api', 'AWS::Serverless::Api', obj([{ key: 'EndpointConfiguration', value: scalar('REGIONAL') }]));
    const graph = model([api]);
    const result = addSyntheticNodes(graph, identityIndex(graph.nodes));
    expect(result.edges).toHaveLength(1);
  });

  test('AWS::Serverless::Api with a PRIVATE string EndpointConfiguration (SAM shorthand) is NOT public', () => {
    const api = node('Api', 'AWS::Serverless::Api', obj([{ key: 'EndpointConfiguration', value: scalar('PRIVATE') }]));
    const graph = model([api]);
    const result = addSyntheticNodes(graph, identityIndex(graph.nodes));
    expect(result.edges).toHaveLength(0);
  });

  test('two distinct ingress sources resolving to the SAME owner collapse to ONE edge, provenance UNIONED', () => {
    const ingress1 = node('Ingress1', 'AWS::EC2::SecurityGroupIngress', obj([{ key: 'CidrIp', value: scalar('0.0.0.0/0') }]));
    const ingress2 = node('Ingress2', 'AWS::EC2::SecurityGroupIngress', obj([{ key: 'CidrIp', value: scalar('::/0') }]));
    const owner = node('Alb', 'AWS::ElasticLoadBalancingV2::LoadBalancer');
    const graph = model([ingress1, ingress2, owner]);
    const nodeIndex = { ...identityIndex(graph.nodes), [ingress1.id]: owner.id, [ingress2.id]: owner.id };

    const result = addSyntheticNodes(graph, nodeIndex);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]!.derivedFrom).toHaveLength(2);
  });

  test('no ingress signal anywhere: no node, no edges', () => {
    const fn = node('Fn', 'AWS::Lambda::Function');
    const graph = model([fn]);
    const result = addSyntheticNodes(graph, identityIndex(graph.nodes));
    expect(result.node).toBeUndefined();
    expect(result.edges).toEqual([]);
  });
});

describe('generate() end-to-end — Ticket A.9 real fixtures', () => {
  const EXAMPLES_DIR = fileURLToPath(new URL('../../../examples/', import.meta.url));

  test('03-multi-stack-ecs-fargate: the public ALB\'s inline 0.0.0.0/0 ingress produces Internet -> PublicLoadBalancer', () => {
    const files = [
      'network-stack/template.yaml',
      'private-subnet-public-service/template.yaml',
      'service-stack/template.yaml',
    ].map((f) => EXAMPLES_DIR + '03-multi-stack-ecs-fargate/' + f);
    const { templates } = loadTemplates(files);
    const arch = generate(mergeGraphs(templates));

    const internetNode = arch.nodes.find((n) => n.id === SYNTHETIC_INTERNET_ID);
    expect(internetNode).toBeDefined();
    expect(internetNode!.inferred).toBe(true);
    expect(internetNode!.decision.action).toBe('synthetic');
    // Not part of the audit-log accounting invariant (it has no source node).
    expect(arch.decisions.some((d) => d.nodeId === SYNTHETIC_INTERNET_ID)).toBe(false);

    const alb = arch.nodes.find((n) => n.resourceType === 'AWS::ElasticLoadBalancingV2::LoadBalancer')!;
    const edge = arch.edges.find((e) => e.source === SYNTHETIC_INTERNET_ID);
    expect(edge).toMatchObject({ target: alb.id, kind: 'network', inferred: true });
  });

  test('09-sam-apigw-lambda-dynamodb: the public (REGIONAL) API Gateway produces Internet -> Api, with no security group in sight', () => {
    const FIXTURE = EXAMPLES_DIR + '09-sam-apigw-lambda-dynamodb/template.yaml';
    const { templates } = loadTemplates([FIXTURE]);
    const arch = generate(mergeGraphs(templates));

    const api = arch.nodes.find((n) => n.service === 'apigateway')!;
    const edge = arch.edges.find((e) => e.source === SYNTHETIC_INTERNET_ID);
    expect(edge).toMatchObject({ target: api.id, kind: 'network', inferred: true });
  });
});
