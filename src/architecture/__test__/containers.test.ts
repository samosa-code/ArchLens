import { describe, expect, test } from 'vitest';
import { classify } from '../classify.js';
import { buildContainers } from '../containers.js';
import type { FileAnnotations } from '../metadata.js';
import type { GraphEdge } from '../../common/types.js';
import type { GraphModel, GraphNode } from '../../common/interfaces.js';

/**
 * Ticket A.4 — Pass 2 (container extraction & nesting): container-role
 * nodes become `ArchContainer`s, nesting from reference edges (Subnet →
 * VPC); account/region containers come from PO Question 27's metadata
 * convention, only when the set spans (spec §8's noise rule).
 */

function node(logicalId: string, type: string | undefined, file = 'test.yaml'): GraphNode {
  return {
    id: `${file}#${logicalId}`,
    logicalId,
    type,
    file,
    pos: { file, line: 1, column: 1 },
    properties: undefined,
    inclusion: { kind: 'included' },
  };
}

function edge(sourceId: string, targetId: string): GraphEdge {
  return { kind: 'reference', source: sourceId, target: targetId, propertyPath: ['X'], via: { kind: 'ref' } };
}

function model(nodes: GraphNode[], edges: GraphEdge[]): GraphModel {
  return { nodes, edges, warnings: [] };
}

function build(graph: GraphModel, annotations?: FileAnnotations) {
  return buildContainers(graph, classify(graph).classifications, annotations);
}

describe('buildContainers — graph-node containers and nesting', () => {
  test('a VPC + Subnet + Instance: subnet container nests in the vpc container; the instance sits in the subnet (deepest referenced container wins)', () => {
    const graph = model(
      [node('Vpc', 'AWS::EC2::VPC'), node('Sub', 'AWS::EC2::Subnet'), node('Server', 'AWS::EC2::Instance')],
      [
        edge('test.yaml#Sub', 'test.yaml#Vpc'), // Subnet's VpcId
        // The VPC ref comes FIRST deliberately: "first referenced wins"
        // must fail this test — only "deepest referenced wins" passes.
        edge('test.yaml#Server', 'test.yaml#Vpc'),
        edge('test.yaml#Server', 'test.yaml#Sub'), // Instance's SubnetId
      ],
    );
    const { containers, containerOf } = build(graph);

    const vpc = containers.find((c) => c.kind === 'vpc')!;
    const subnet = containers.find((c) => c.kind === 'subnet')!;
    expect(vpc.sourceNodeId).toBe('test.yaml#Vpc');
    expect(vpc.parentId).toBeUndefined();
    expect(subnet.parentId).toBe(vpc.id);
    expect(containerOf.get('test.yaml#Server')).toBe(subnet.id);
  });

  test('ECS and CloudFormation stack containers get their declared kinds', () => {
    const graph = model([node('Cluster', 'AWS::ECS::Cluster'), node('Nested', 'AWS::CloudFormation::Stack')], []);
    const { containers } = build(graph);
    expect(containers.find((c) => c.sourceNodeId === 'test.yaml#Cluster')!.kind).toBe('cluster');
    expect(containers.find((c) => c.sourceNodeId === 'test.yaml#Nested')!.kind).toBe('stack');
  });

  test('a node referencing no container gets no containerOf entry (top level)', () => {
    const graph = model([node('Fn', 'AWS::Lambda::Function')], []);
    expect(build(graph).containerOf.has('test.yaml#Fn')).toBe(false);
  });
});

describe('buildContainers — account/region containers (PO Questions 20/27, spec §8 noise rule)', () => {
  const HUB = 'hub.yaml';
  const SPOKE_US = 'spoke-us.yaml';
  const SPOKE_EU = 'spoke-eu.yaml';

  function spanningGraph(): GraphModel {
    return model(
      [
        node('CentralBus', 'AWS::Events::EventBus', HUB),
        node('AppVpc', 'AWS::EC2::VPC', SPOKE_US),
        node('AppServer', 'AWS::EC2::Instance', SPOKE_US),
        node('ReplicaFn', 'AWS::Lambda::Function', SPOKE_EU),
      ],
      [],
    );
  }

  const spanningAnnotations: FileAnnotations = new Map([
    [HUB, { account: 'Hub', region: 'us-east-1' }],
    [SPOKE_US, { account: 'Spoke', region: 'us-east-1' }],
    [SPOKE_EU, { account: 'Spoke', region: 'eu-west-1' }],
  ]);

  test('two accounts + two regions: account containers, region containers nested per account, nodes and vpc containers placed in their file\'s region', () => {
    const { containers, containerOf } = build(spanningGraph(), spanningAnnotations);

    const accounts = containers.filter((c) => c.kind === 'account');
    const regions = containers.filter((c) => c.kind === 'region');
    expect(accounts.map((c) => c.label).sort()).toEqual(['Hub', 'Spoke']);
    // One region container per (account, region) pair actually present: Hub/us-east-1, Spoke/us-east-1, Spoke/eu-west-1.
    expect(regions).toHaveLength(3);

    const hub = accounts.find((c) => c.label === 'Hub')!;
    const spoke = accounts.find((c) => c.label === 'Spoke')!;
    const hubUs = regions.find((c) => c.parentId === hub.id)!;
    expect(hubUs.label).toBe('us-east-1');
    const spokeRegions = regions.filter((c) => c.parentId === spoke.id);
    expect(spokeRegions.map((c) => c.label).sort()).toEqual(['eu-west-1', 'us-east-1']);

    // Synthetic containers represent no graph node.
    expect(hub.sourceNodeId).toBeUndefined();
    expect(hubUs.sourceNodeId).toBeUndefined();

    const spokeUsRegion = spokeRegions.find((c) => c.label === 'us-east-1')!;
    const spokeEuRegion = spokeRegions.find((c) => c.label === 'eu-west-1')!;
    expect(containerOf.get(`${HUB}#CentralBus`)).toBe(hubUs.id);
    expect(containerOf.get(`${SPOKE_EU}#ReplicaFn`)).toBe(spokeEuRegion.id);
    // The VPC container's parent is its file's region container; the
    // instance (no container refs here) also lands in the region.
    expect(containers.find((c) => c.kind === 'vpc')!.parentId).toBe(spokeUsRegion.id);
    expect(containerOf.get(`${SPOKE_US}#AppServer`)).toBe(spokeUsRegion.id);
  });

  test('one account, one region: no span → no account/region containers at all (spec §8: otherwise noise)', () => {
    const annotations: FileAnnotations = new Map([
      [HUB, { account: 'OnlyAccount', region: 'us-east-1' }],
      [SPOKE_US, { account: 'OnlyAccount', region: 'us-east-1' }],
    ]);
    const { containers } = build(spanningGraph(), annotations);
    expect(containers.some((c) => c.kind === 'account' || c.kind === 'region')).toBe(false);
  });

  test('accounts span but regions do not: account containers only, nodes placed directly in their account', () => {
    const annotations: FileAnnotations = new Map([
      [HUB, { account: 'Hub', region: 'us-east-1' }],
      [SPOKE_US, { account: 'Spoke', region: 'us-east-1' }],
    ]);
    const { containers, containerOf } = build(spanningGraph(), annotations);
    expect(containers.some((c) => c.kind === 'region')).toBe(false);
    const hub = containers.find((c) => c.kind === 'account' && c.label === 'Hub')!;
    expect(containerOf.get(`${HUB}#CentralBus`)).toBe(hub.id);
  });

  test('unannotated files stay outside every account/region boundary', () => {
    const graph = model(
      [node('CentralBus', 'AWS::Events::EventBus', HUB), node('OtherFn', 'AWS::Lambda::Function', 'plain.yaml'), node('Bus2', 'AWS::Events::EventBus', SPOKE_US)],
      [],
    );
    const annotations: FileAnnotations = new Map([
      [HUB, { account: 'Hub' }],
      [SPOKE_US, { account: 'Spoke' }],
    ]);
    const { containerOf } = build(graph, annotations);
    expect(containerOf.has('plain.yaml#OtherFn')).toBe(false);
  });
});
