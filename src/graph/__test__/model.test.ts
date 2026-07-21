import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { loadTemplate } from '../../parser/loader.js';
import { buildGraph, nodeId } from '../model.js';
import type { GraphEdge } from '../../common/types.js';

const FIXTURES = new URL('./__fixtures__/', import.meta.url);
const REAL_WORLD_EXAMPLES = new URL('../../../examples/', import.meta.url);

function fixturePath(name: string): string {
  return fileURLToPath(new URL(name, FIXTURES));
}

function examplePath(name: string): string {
  return fileURLToPath(new URL(name, REAL_WORLD_EXAMPLES));
}

const FILE = fixturePath('graph-basic.yaml');

function buildFixtureGraph() {
  const template = loadTemplate(FILE);
  return buildGraph(FILE, template);
}

function node(graph: ReturnType<typeof buildFixtureGraph>, logicalId: string) {
  const found = graph.nodes.find((n) => n.logicalId === logicalId);
  if (!found) throw new Error(`no node for logicalId "${logicalId}"`);
  return found;
}

function edgesFrom(graph: ReturnType<typeof buildFixtureGraph>, sourceLogicalId: string): GraphEdge[] {
  const sourceId = nodeId(FILE, sourceLogicalId);
  return graph.edges.filter((e) => e.source === sourceId);
}

describe('nodeId', () => {
  test('combines file and logicalId with a # separator', () => {
    expect(nodeId('/a/b.yaml', 'MyBucket')).toBe('/a/b.yaml#MyBucket');
  });
});

describe('buildGraph — nodes', () => {
  test('creates one node per declared resource', () => {
    const graph = buildFixtureGraph();
    const logicalIds = graph.nodes.map((n) => n.logicalId).sort();
    expect(logicalIds).toEqual(
      [
        'MyBucket',
        'Consumer',
        'ExcludedResource',
        'UnknownInclusionResource',
        'DependsOnScalar',
        'DependsOnArray',
        'DependsOnDuplicate',
        'DependsOnInvalidTarget',
        'DependsOnMixedValidity',
        'DependsOnMalformed',
        'ResourceWithMetadataOnly',
        'NoPropertiesResource',
      ].sort(),
    );
  });

  test('node id is `${file}#${logicalId}`, never just the logical id', () => {
    const graph = buildFixtureGraph();
    expect(node(graph, 'MyBucket').id).toBe(`${FILE}#MyBucket`);
  });

  test('node carries type, file, and resolved properties', () => {
    const graph = buildFixtureGraph();
    const bucket = node(graph, 'MyBucket');
    expect(bucket.type).toBe('AWS::S3::Bucket');
    expect(bucket.file).toBe(FILE);
    expect(bucket.properties).toBeUndefined();
  });

  test('a resource with no Properties block still gets a node with properties: undefined', () => {
    const graph = buildFixtureGraph();
    expect(node(graph, 'NoPropertiesResource').properties).toBeUndefined();
  });

  test('node position points at the resource declaration', () => {
    const graph = buildFixtureGraph();
    const bucket = node(graph, 'MyBucket');
    expect(bucket.pos.file).toBe(FILE);
    expect(bucket.pos.line).toBeGreaterThan(0);
  });

  test('a resource excluded by a statically-false Condition still produces a node, marked excluded', () => {
    const graph = buildFixtureGraph();
    expect(node(graph, 'ExcludedResource').inclusion).toEqual({ kind: 'excluded' });
  });

  test('a resource referencing an undefined condition still produces a node, marked unknown', () => {
    const graph = buildFixtureGraph();
    const inclusion = node(graph, 'UnknownInclusionResource').inclusion;
    expect(inclusion.kind).toBe('unknown');
  });

  test('a resource with no Condition attribute is always included', () => {
    const graph = buildFixtureGraph();
    expect(node(graph, 'MyBucket').inclusion).toEqual({ kind: 'included' });
  });
});

describe('buildGraph — reference edges', () => {
  test('a Ref in Properties produces a reference edge to the target node', () => {
    const graph = buildFixtureGraph();
    const edges = edgesFrom(graph, 'Consumer').filter(
      (e): e is Extract<GraphEdge, { kind: 'reference' }> => e.kind === 'reference' && e.propertyPath[0] === 'RefEdge',
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]!.target).toBe(nodeId(FILE, 'MyBucket'));
    expect(edges[0]!.via).toEqual({ kind: 'ref' });
  });

  test('a Fn::GetAtt in Properties produces a reference edge tagged with the attribute', () => {
    const graph = buildFixtureGraph();
    const edges = edgesFrom(graph, 'Consumer').filter(
      (e): e is Extract<GraphEdge, { kind: 'reference' }> =>
        e.kind === 'reference' && e.propertyPath[0] === 'GetAttEdge',
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]!.target).toBe(nodeId(FILE, 'MyBucket'));
    expect(edges[0]!.via).toEqual({ kind: 'getAtt', attribute: 'Arn' });
  });

  test('the same target referenced twice in a list produces two distinct edges, not collapsed', () => {
    const graph = buildFixtureGraph();
    const edges = edgesFrom(graph, 'Consumer').filter(
      (e): e is Extract<GraphEdge, { kind: 'reference' }> =>
        e.kind === 'reference' && e.propertyPath[0] === 'DuplicateRefList',
    );
    expect(edges).toHaveLength(2);
    expect(edges.map((e) => e.propertyPath)).toEqual(
      expect.arrayContaining([
        ['DuplicateRefList', '0'],
        ['DuplicateRefList', '1'],
      ]),
    );
  });

  test('a Ref nested inside a Fn::Join is still found and produces an edge', () => {
    const graph = buildFixtureGraph();
    const edges = edgesFrom(graph, 'Consumer').filter(
      (e): e is Extract<GraphEdge, { kind: 'reference' }> => e.kind === 'reference' && e.propertyPath[0] === 'JoinedRef',
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]!.target).toBe(nodeId(FILE, 'MyBucket'));
  });

  test('a Ref nested inside a Fn::ImportValue export-name expression does NOT produce a reference edge', () => {
    const graph = buildFixtureGraph();
    const edges = edgesFrom(graph, 'Consumer').filter((e) => e.kind === 'reference' && e.propertyPath[0] === 'ImportValueWithRef');
    expect(edges).toHaveLength(0);
  });

  test('reference edges only originate from Properties, e.g. Metadata is never walked for edges', () => {
    const graph = buildFixtureGraph();
    expect(edgesFrom(graph, 'ResourceWithMetadataOnly')).toHaveLength(0);
  });
});

describe('buildGraph — dependsOn edges', () => {
  test('a scalar-string DependsOn produces one dependsOn edge', () => {
    const graph = buildFixtureGraph();
    const edges = edgesFrom(graph, 'DependsOnScalar');
    expect(edges).toEqual([{ kind: 'dependsOn', source: nodeId(FILE, 'DependsOnScalar'), target: nodeId(FILE, 'MyBucket') }]);
  });

  test('an array-form DependsOn produces one dependsOn edge per entry', () => {
    const graph = buildFixtureGraph();
    const edges = edgesFrom(graph, 'DependsOnArray');
    expect(edges).toEqual(
      expect.arrayContaining([
        { kind: 'dependsOn', source: nodeId(FILE, 'DependsOnArray'), target: nodeId(FILE, 'MyBucket') },
        { kind: 'dependsOn', source: nodeId(FILE, 'DependsOnArray'), target: nodeId(FILE, 'Consumer') },
      ]),
    );
    expect(edges).toHaveLength(2);
  });

  test('the same DependsOn target listed twice produces two edges, not collapsed', () => {
    const graph = buildFixtureGraph();
    const edges = edgesFrom(graph, 'DependsOnDuplicate');
    expect(edges).toHaveLength(2);
    expect(edges.every((e) => e.target === nodeId(FILE, 'MyBucket'))).toBe(true);
  });

  test('a DependsOn target that is not a declared resource produces a warning, not an edge', () => {
    const graph = buildFixtureGraph();
    expect(edgesFrom(graph, 'DependsOnInvalidTarget')).toHaveLength(0);
    expect(graph.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: FILE, logicalId: 'DependsOnInvalidTarget', message: expect.stringContaining('NoSuchResource') }),
      ]),
    );
  });

  test('in a mixed-validity array, valid targets still produce edges alongside a warning for the invalid one', () => {
    const graph = buildFixtureGraph();
    const edges = edgesFrom(graph, 'DependsOnMixedValidity');
    expect(edges).toEqual([
      { kind: 'dependsOn', source: nodeId(FILE, 'DependsOnMixedValidity'), target: nodeId(FILE, 'MyBucket') },
    ]);
    expect(graph.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ logicalId: 'DependsOnMixedValidity', message: expect.stringContaining('NoSuchResourceEither') })]),
    );
  });

  test('a malformed DependsOn (not a string or array of strings) produces a warning and no edges', () => {
    const graph = buildFixtureGraph();
    expect(edgesFrom(graph, 'DependsOnMalformed')).toHaveLength(0);
    expect(graph.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ logicalId: 'DependsOnMalformed' })]),
    );
  });

  test('a resource with no DependsOn attribute produces no dependsOn edges', () => {
    const graph = buildFixtureGraph();
    expect(edgesFrom(graph, 'MyBucket').filter((e) => e.kind === 'dependsOn')).toHaveLength(0);
  });
});

describe('buildGraph — node identity across files (PO Question 4d)', () => {
  test('two unrelated files declaring the same logical id produce two distinct nodes', () => {
    const fileA = FILE;
    const fileB = fixturePath('graph-other-file.yaml');
    const graphA = buildGraph(fileA, loadTemplate(fileA));
    const graphB = buildGraph(fileB, loadTemplate(fileB));

    const idA = node(graphA, 'MyBucket').id;
    const idB = graphB.nodes.find((n) => n.logicalId === 'MyBucket')!.id;

    expect(idA).not.toBe(idB);
  });
});

describe('buildGraph — real-world fixtures', () => {
  test('builds a plausible graph from examples/01-simple-lambda without crashing', () => {
    const file = examplePath('01-simple-lambda/template.yaml');
    const graph = buildGraph(file, loadTemplate(file));
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.nodes.every((n) => n.file === file)).toBe(true);
  });

  test('builds a plausible graph from examples/03-multi-stack-ecs-fargate/network-stack without crashing', () => {
    const file = examplePath('03-multi-stack-ecs-fargate/network-stack/template.yaml');
    const graph = buildGraph(file, loadTemplate(file));
    expect(graph.nodes.length).toBeGreaterThan(0);
  });

  test('builds a plausible graph from examples/02-complex-vpc-nat, with reference edges present', () => {
    const file = examplePath('02-complex-vpc-nat/template.yaml');
    const graph = buildGraph(file, loadTemplate(file));
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.edges.some((e) => e.kind === 'reference')).toBe(true);
  });

  test('builds plausible graphs from all three examples/06-nested-stack-quickstart templates', () => {
    for (const name of ['root.template.yaml', 'bastion-child.template.yaml', 'vpc-child.template.yaml']) {
      const file = examplePath(`06-nested-stack-quickstart/${name}`);
      const graph = buildGraph(file, loadTemplate(file));
      expect(graph.nodes.length).toBeGreaterThan(0);
      expect(graph.nodes.every((n) => n.file === file)).toBe(true);
    }
  });

  test('builds a plausible graph from examples/11-large-production-wordpress-ha, including dependsOn edges', () => {
    const file = examplePath('11-large-production-wordpress-ha/template.yaml');
    const graph = buildGraph(file, loadTemplate(file));
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.edges.some((e) => e.kind === 'reference')).toBe(true);
  });

  test('no real-world fixture produces a node whose id lacks its own file, or a dangling reference-edge target', () => {
    const files = [
      '01-simple-lambda/template.yaml',
      '02-complex-vpc-nat/template.yaml',
      '03-multi-stack-ecs-fargate/network-stack/template.yaml',
      '06-nested-stack-quickstart/root.template.yaml',
      '11-large-production-wordpress-ha/template.yaml',
    ];
    for (const name of files) {
      const file = examplePath(name);
      const graph = buildGraph(file, loadTemplate(file));
      const ids = new Set(graph.nodes.map((n) => n.id));
      expect(ids.size).toBe(graph.nodes.length);
      for (const edge of graph.edges) {
        if (edge.kind === 'reference' || edge.kind === 'dependsOn') {
          expect(ids.has(edge.target)).toBe(true);
        }
      }
    }
  });
});
