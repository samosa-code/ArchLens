import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { loadTemplate } from '../../parser/loader.js';
import { mergeGraphs } from '../merge.js';
import { buildGraph, nodeId } from '../model.js';
import { assumedStackName } from '../stackName.js';
import type { LoadedTemplate } from '../../common/interfaces.js';
import type { GraphEdge } from '../../common/types.js';

const FIXTURES = new URL('./__fixtures__/', import.meta.url);
const REAL_WORLD_EXAMPLES = new URL('../../../examples/', import.meta.url);

function fixturePath(name: string): string {
  return fileURLToPath(new URL(name, FIXTURES));
}

function examplePath(name: string): string {
  return fileURLToPath(new URL(name, REAL_WORLD_EXAMPLES));
}

function loaded(file: string): LoadedTemplate {
  return { file, ast: loadTemplate(file) };
}

const EXPORTER_ONE = fixturePath('merge-exporter-one.yaml');
const EXPORTER_TWO = fixturePath('merge-exporter-two.yaml');
const CONSUMER = fixturePath('merge-consumer.yaml');

function crossStackEdgesFrom(edges: GraphEdge[], sourceId: string, propertyPathHead: string): Extract<GraphEdge, { kind: 'crossStackImport' }>[] {
  return edges.filter(
    (e): e is Extract<GraphEdge, { kind: 'crossStackImport' }> => e.kind === 'crossStackImport' && e.source === sourceId && e.propertyPath[0] === propertyPathHead,
  );
}

describe('mergeGraphs — synthetic multi-strategy matching', () => {
  const templates = [loaded(EXPORTER_ONE), loaded(EXPORTER_TWO), loaded(CONSUMER)];
  const graph = mergeGraphs(templates);
  const consumerSource = nodeId(CONSUMER, 'ConsumerFn');

  test('combines every template\'s nodes and edges (Ticket 2.1 output preserved)', () => {
    const logicalIds = graph.nodes.map((n) => n.logicalId).sort();
    expect(logicalIds).toEqual(['ConsumerFn', 'ExportedBucket', 'OtherBucket'].sort());
  });

  test('an exact-match import (no pseudo parameters involved) resolves to a crossStackImport edge, via ref', () => {
    const edges = crossStackEdgesFrom(graph.edges, consumerSource, 'ExactMatchImport');
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      target: nodeId(EXPORTER_ONE, 'ExportedBucket'),
      via: { kind: 'ref' },
      exportName: 'PlainExportName',
      matchedVia: 'exact',
    });
  });

  test('a shared AWS::Region assumption on both sides resolves via assumedPseudoParameter, via getAtt', () => {
    const edges = crossStackEdgesFrom(graph.edges, consumerSource, 'PseudoParamImport');
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      target: nodeId(EXPORTER_ONE, 'ExportedBucket'),
      via: { kind: 'getAtt', attribute: 'Arn' },
      exportName: 'assumed-region-GlobalThing',
      matchedVia: 'assumedPseudoParameter',
    });
  });

  test('PO 4f: a regular Parameter (not AWS::StackName) whose Default matches nothing resolves via a sibling\'s assumed stack name', () => {
    const edges = crossStackEdgesFrom(graph.edges, consumerSource, 'CandidateStackNameImport');
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      target: nodeId(EXPORTER_TWO, 'OtherBucket'),
      exportName: `${assumedStackName(EXPORTER_TWO)}:ParamStyle`,
      matchedVia: 'assumedCandidateStackName',
    });
  });

  test('two different sibling candidates matching two different exports is ambiguous — flagged unresolved, no edge', () => {
    expect(crossStackEdgesFrom(graph.edges, consumerSource, 'AmbiguousCandidateImport')).toHaveLength(0);
    expect(graph.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'unresolvedImport',
          file: CONSUMER,
          logicalId: 'ConsumerFn',
          message: expect.stringContaining('ambiguous'),
        }),
      ]),
    );
  });

  test('an import matching a name already flagged as a duplicate export conflict is unresolved, with a distinguishable message', () => {
    expect(crossStackEdgesFrom(graph.edges, consumerSource, 'DuplicateNameImport')).toHaveLength(0);
    const warning = graph.warnings.find(
      (w) => w.kind === 'unresolvedImport' && w.logicalId === 'ConsumerFn' && w.message.includes('SharedAmbiguousExportName'),
    );
    expect(warning).toBeDefined();
    if (warning?.kind === 'unresolvedImport') {
      expect(warning.message).toContain('more than one template');
    }
  });

  test('a matched export whose Value is a plain literal (no resource leaf) produces no edge and no warning', () => {
    expect(crossStackEdgesFrom(graph.edges, consumerSource, 'LiteralValueImport')).toHaveLength(0);
    expect(graph.warnings.some((w) => w.kind === 'unresolvedImport' && w.message.includes('LiteralValueExportName'))).toBe(false);
  });

  test('an import referencing an export that exists nowhere is flagged unresolved, distinguishable from the ambiguous case', () => {
    expect(crossStackEdgesFrom(graph.edges, consumerSource, 'GenuinelyMissingImport')).toHaveLength(0);
    const warning = graph.warnings.find(
      (w) => w.kind === 'unresolvedImport' && w.message.includes('NoSuchExportAnywhere'),
    );
    expect(warning).toBeDefined();
    if (warning?.kind === 'unresolvedImport') {
      expect(warning.message).toContain('not exported by any provided template');
    }
  });
});

describe('mergeGraphs — real-world fixtures', () => {
  test('examples/03-multi-stack-ecs-fargate: every service-stack import resolves via a sibling\'s assumed stack name', () => {
    const networkFile = examplePath('03-multi-stack-ecs-fargate/network-stack/template.yaml');
    const serviceFile = examplePath('03-multi-stack-ecs-fargate/service-stack/template.yaml');
    const graph = mergeGraphs([loaded(networkFile), loaded(serviceFile)]);

    const crossStackEdges = graph.edges.filter((e): e is Extract<GraphEdge, { kind: 'crossStackImport' }> => e.kind === 'crossStackImport');
    expect(crossStackEdges.length).toBeGreaterThanOrEqual(7);
    expect(crossStackEdges.every((e) => e.matchedVia === 'assumedCandidateStackName')).toBe(true);
    expect(crossStackEdges.every((e) => e.target.startsWith(networkFile))).toBe(true);

    const clusterEdge = crossStackEdges.find((e) => e.exportName.endsWith(':ClusterName'));
    expect(clusterEdge).toBeDefined();
    expect(clusterEdge!.target).toBe(nodeId(networkFile, 'ECSCluster'));

    const importWarnings = graph.warnings.filter((w) => w.kind === 'unresolvedImport');
    expect(importWarnings).toHaveLength(0);
  });

  test('examples/04-unresolved-import: every import is genuinely unresolvable with no sibling template provided', () => {
    const file = examplePath('04-unresolved-import/template.yaml');
    const graph = mergeGraphs([loaded(file)]);

    const crossStackEdges = graph.edges.filter((e) => e.kind === 'crossStackImport');
    expect(crossStackEdges).toHaveLength(0);

    const importWarnings = graph.warnings.filter((w) => w.kind === 'unresolvedImport');
    expect(importWarnings.length).toBeGreaterThan(0);
    expect(importWarnings.every((w) => w.file === file)).toBe(true);
  });

  test('the run succeeds with a partial graph rather than throwing (PO Question 4)', () => {
    const file = examplePath('04-unresolved-import/template.yaml');
    expect(() => mergeGraphs([loaded(file)])).not.toThrow();
    const graph = mergeGraphs([loaded(file)]);
    expect(graph.nodes.length).toBeGreaterThan(0);
  });
});

describe('mergeGraphs — Ticket 2.4 integration: realistic 3-template cross-referencing fixture', () => {
  const NETWORK = examplePath('03-multi-stack-ecs-fargate/network-stack/template.yaml');
  const SERVICE = examplePath('03-multi-stack-ecs-fargate/service-stack/template.yaml');
  const PRIVATE_SERVICE = examplePath('03-multi-stack-ecs-fargate/private-subnet-public-service/template.yaml');
  const trio = [loaded(NETWORK), loaded(SERVICE), loaded(PRIVATE_SERVICE)];

  test('node count exactly equals the sum of each template\'s own resource count (independently counted: 19 + 4 + 4)', () => {
    const graph = mergeGraphs(trio);
    expect(graph.nodes.length).toBe(27);
    // Cross-check against Ticket 2.1's buildGraph directly, not just a hardcoded number.
    const expectedNodeCount = trio.reduce((sum, t) => sum + buildGraph(t.file, t.ast).nodes.length, 0);
    expect(graph.nodes.length).toBe(expectedNodeCount);
  });

  test('every per-template reference/dependsOn edge from Ticket 2.1 is preserved by the merge, none dropped or duplicated', () => {
    const graph = mergeGraphs(trio);
    const mergedNonCrossStackCount = graph.edges.filter((e) => e.kind !== 'crossStackImport').length;
    const expectedCount = trio.reduce(
      (sum, t) => sum + buildGraph(t.file, t.ast).edges.filter((e) => e.kind !== 'crossStackImport').length,
      0,
    );
    expect(mergedNonCrossStackCount).toBe(expectedCount);
  });

  test('service-stack\'s 7 imports all resolve against network-stack; private-subnet-public-service resolves 5 of 7 (it genuinely wants a different, private-subnet-having network stack)', () => {
    const graph = mergeGraphs(trio);
    const crossStackEdges = graph.edges.filter((e): e is Extract<GraphEdge, { kind: 'crossStackImport' }> => e.kind === 'crossStackImport');

    expect(crossStackEdges).toHaveLength(12);
    expect(crossStackEdges.every((e) => e.target.startsWith(NETWORK))).toBe(true);

    const fromService = crossStackEdges.filter((e) => e.source.startsWith(SERVICE));
    const fromPrivateService = crossStackEdges.filter((e) => e.source.startsWith(PRIVATE_SERVICE));
    expect(fromService).toHaveLength(7);
    expect(fromPrivateService).toHaveLength(5);

    // network-stack (public-vpc.yaml upstream) only exports public subnets — it
    // genuinely has no PrivateSubnetOne/PrivateSubnetTwo export, so these two
    // of private-subnet-public-service's imports are correctly unresolved, not
    // a bug: this fixture pair was never meant to be a fully-resolving trio,
    // only a "shares several exports" sibling per its own SOURCE.md.
    const importWarnings = graph.warnings.filter((w) => w.kind === 'unresolvedImport');
    expect(importWarnings).toHaveLength(2);
    expect(importWarnings.every((w) => w.file === PRIVATE_SERVICE && w.logicalId === 'Service')).toBe(true);
    expect(importWarnings.map((w) => w.message)).toEqual(
      expect.arrayContaining([expect.stringContaining('PrivateSubnetOne'), expect.stringContaining('PrivateSubnetTwo')]),
    );
  });

  test('total edge count is the sum of preserved per-template edges plus the 12 new crossStackImport edges', () => {
    const graph = mergeGraphs(trio);
    const expectedNonCrossStack = trio.reduce(
      (sum, t) => sum + buildGraph(t.file, t.ast).edges.filter((e) => e.kind !== 'crossStackImport').length,
      0,
    );
    expect(graph.edges.length).toBe(expectedNonCrossStack + 12);
  });
});
