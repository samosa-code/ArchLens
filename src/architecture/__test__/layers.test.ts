import { describe, expect, test } from 'vitest';
import { inferDirection } from '../layers.js';
import { generate } from '../generate.js';
import type { ArchEdge, ArchNode } from '../types.js';
import type { GraphEdge, ResolvedValue } from '../../common/types.js';
import type { GraphModel, GraphNode } from '../../common/interfaces.js';

/**
 * Ticket A.8 — Pass 6 (partial): direction inference (spec §6). Layers
 * themselves are rule-assigned (already the case since A.1/A.2); this
 * ticket only reorders edge endpoints using each pair's layer index, per
 * kind:
 *   containment -> untouched (already nesting, not an arrow)
 *   invocation  -> untouched (connector's declared direction is explicit)
 *   network     -> untouched (declared source SG -> target SG)
 *   dataAccess  -> accessor (lower layer index) -> store
 *   association -> ordered by layer index; tied layers keep template
 *                  direction but are flagged `heuristic` (spec's documented
 *                  limitation — arbitrary, not verified)
 */

function archNode(id: string, layer: ArchNode['layer']): ArchNode {
  return {
    id,
    label: id,
    service: 'unknown',
    resourceType: 'Test::Resource',
    layer,
    sourceNodeId: id,
    absorbed: [],
    decision: { nodeId: id, action: 'kept', rule: 'test', reason: 'test', confidence: 'rule' },
    badges: [],
  };
}

function archEdge(partial: Partial<ArchEdge> & Pick<ArchEdge, 'source' | 'target' | 'kind'>): ArchEdge {
  return {
    id: `${partial.source}->${partial.target}:${partial.kind}`,
    delivery: 'sync',
    derivedFrom: [],
    confidence: 'rule',
    inferred: false,
    ...partial,
  };
}

describe('inferDirection — spec §6 direction rules', () => {
  test('containment is never touched, even with out-of-order layers', () => {
    const nodes = [archNode('A', 'data'), archNode('B', 'compute')];
    const edge = archEdge({ source: 'A', target: 'B', kind: 'containment' });
    expect(inferDirection(nodes, [edge])).toEqual([edge]);
  });

  test('invocation keeps the connector\'s declared direction, even same-layer', () => {
    const nodes = [archNode('A', 'compute'), archNode('B', 'compute')];
    const edge = archEdge({ source: 'A', target: 'B', kind: 'invocation', label: 'invokes' });
    expect(inferDirection(nodes, [edge])).toEqual([edge]);
  });

  test('invocation keeps the connector\'s declared direction even when layer order would "correct" it (a naive layer-index reorder would wrongly flip this)', () => {
    // Queue (integration, idx5) -> Fn (compute, idx4): layer-index order
    // would put Fn first, but the connector already declared the real
    // direction (queue triggers the function) — must not be touched.
    const nodes = [archNode('Queue', 'integration'), archNode('Fn', 'compute')];
    const edge = archEdge({ source: 'Queue', target: 'Fn', kind: 'invocation', label: 'triggers' });
    expect(inferDirection(nodes, [edge])).toEqual([edge]);
  });

  test('network keeps declared source SG -> target SG, even "backwards" by layer', () => {
    const nodes = [archNode('A', 'data'), archNode('B', 'compute')];
    const edge = archEdge({ source: 'A', target: 'B', kind: 'network', label: 'can reach' });
    expect(inferDirection(nodes, [edge])).toEqual([edge]);
  });

  test('dataAccess already accessor -> store (lower index -> higher) is left alone', () => {
    const nodes = [archNode('Fn', 'compute'), archNode('Table', 'data')];
    const edge = archEdge({ source: 'Fn', target: 'Table', kind: 'dataAccess' });
    const [result] = inferDirection(nodes, [edge]);
    expect(result).toMatchObject({ source: 'Fn', target: 'Table', inferred: false });
  });

  test('dataAccess declared store -> accessor gets flipped, and marked inferred', () => {
    const nodes = [archNode('Table', 'data'), archNode('Fn', 'compute')];
    const edge = archEdge({ source: 'Table', target: 'Fn', kind: 'dataAccess' });
    const [result] = inferDirection(nodes, [edge]);
    expect(result).toMatchObject({ source: 'Fn', target: 'Table', inferred: true });
  });

  test('dataAccess tied layers: kept as declared, NOT flagged heuristic (the connector rule chose the accessor deliberately)', () => {
    const nodes = [archNode('FnA', 'compute'), archNode('FnB', 'compute')];
    const edge = archEdge({ source: 'FnA', target: 'FnB', kind: 'dataAccess', confidence: 'rule' });
    const [result] = inferDirection(nodes, [edge]);
    expect(result).toMatchObject({ source: 'FnA', target: 'FnB', inferred: false, confidence: 'rule' });
  });

  test('association ordered correctly (lower index already source) is left alone', () => {
    const nodes = [archNode('Fn', 'compute'), archNode('Table', 'data')];
    const edge = archEdge({ source: 'Fn', target: 'Table', kind: 'association' });
    const [result] = inferDirection(nodes, [edge]);
    expect(result).toMatchObject({ source: 'Fn', target: 'Table', inferred: false, confidence: 'rule' });
  });

  test('association out of order (higher index declared as source) gets flipped and marked inferred', () => {
    const nodes = [archNode('Table', 'data'), archNode('Fn', 'compute')];
    const edge = archEdge({ source: 'Table', target: 'Fn', kind: 'association' });
    const [result] = inferDirection(nodes, [edge]);
    expect(result).toMatchObject({ source: 'Fn', target: 'Table', inferred: true });
  });

  test('KNOWN LIMITATION (spec §6): two same-layer components joined by a direct association get arbitrary template direction — flagged heuristic, not asserted correct', () => {
    const nodes = [archNode('FnA', 'compute'), archNode('FnB', 'compute')];
    const edge = archEdge({ source: 'FnA', target: 'FnB', kind: 'association', confidence: 'rule' });
    const [result] = inferDirection(nodes, [edge]);
    // Direction is NOT reordered (no signal to do so) ...
    expect(result).toMatchObject({ source: 'FnA', target: 'FnB', inferred: false });
    // ... but it must no longer claim rule-verified confidence: this is the
    // documented limitation, not a correctness guarantee.
    expect(result!.confidence).toBe('heuristic');
  });

  test('monitoring/network/unassigned sit outside the ordering: an association touching one is treated like a tie (flagged, unflipped)', () => {
    const nodes = [archNode('Fn', 'compute'), archNode('Dash', 'monitoring')];
    const edge = archEdge({ source: 'Dash', target: 'Fn', kind: 'association', confidence: 'rule' });
    const [result] = inferDirection(nodes, [edge]);
    expect(result).toMatchObject({ source: 'Dash', target: 'Fn', inferred: false, confidence: 'heuristic' });
  });

  test('an edge endpoint that resolves to a container (no ArchNode layer) is left untouched', () => {
    const nodes = [archNode('Fn', 'compute')];
    const edge = archEdge({ source: 'Fn', target: 'SomeContainer', kind: 'association' });
    expect(inferDirection(nodes, [edge])).toEqual([edge]);
  });

  test('flipping can newly collide two Pass-5-distinct edges (real case: 09-sam-apigw-lambda-dynamodb Api<->Fn) — merged, provenance UNIONED, not discarded', () => {
    const nodes = [archNode('Api', 'api'), archNode('Fn', 'compute')];
    // api(3) < compute(4): Api -> Fn is already flow-ordered; Fn -> Api is
    // backward and gets flipped onto the same pair.
    const alreadyOrdered = archEdge({
      source: 'Api',
      target: 'Fn',
      kind: 'association',
      derivedFrom: [{ kind: 'reference', file: 'a.yaml', line: 1 }],
    });
    const backward = archEdge({
      source: 'Fn',
      target: 'Api',
      kind: 'association',
      derivedFrom: [{ kind: 'reference', file: 'b.yaml', line: 2 }],
    });
    const result = inferDirection(nodes, [alreadyOrdered, backward]);
    expect(result).toHaveLength(1);
    // api(3) is earlier in flow order than compute(4), so Api -> Fn wins.
    expect(result[0]).toMatchObject({ source: 'Api', target: 'Fn', kind: 'association' });
    expect(result[0]!.derivedFrom).toHaveLength(2);
  });
});

// --- Full-pipeline integration tests (real orchestration order, hand-built templates) ---

function node(logicalId: string, type: string, properties?: ResolvedValue): GraphNode {
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

describe('generate() end-to-end — Pass 6 direction inference', () => {
  test('AC example: two Lambdas related via SQS get the connector-declared (async invocation) direction, not layer-order guesswork', () => {
    // FnA can send to the queue (IAM policy grant); FnB is triggered by it
    // (EventSourceMapping). Both Lambdas are 'compute' layer — the queue in
    // between is what supplies a real direction signal, not layer order.
    const graph = model(
      [
        node('FnA', 'AWS::Lambda::Function'),
        node('FnB', 'AWS::Lambda::Function'),
        node('Queue', 'AWS::SQS::Queue'),
        node('Mapping', 'AWS::Lambda::EventSourceMapping', {
          kind: 'object',
          entries: [
            { key: 'EventSourceArn', value: { kind: 'scalar', value: 'placeholder' } },
            { key: 'FunctionName', value: { kind: 'scalar', value: 'placeholder' } },
          ],
        }),
      ],
      [
        refEdge('Mapping', 'Queue', ['EventSourceArn']),
        refEdge('Mapping', 'FnB', ['FunctionName']),
      ],
    );
    const arch = generate(graph);
    const invocation = arch.edges.find((e) => e.kind === 'invocation');
    expect(invocation).toMatchObject({
      source: 'test.yaml#Queue',
      target: 'test.yaml#FnB',
      inferred: false,
      confidence: 'rule',
    });
  });

  test('KNOWN LIMITATION end-to-end: two same-layer Lambdas with a direct reference (no connector) survive as an association flagged heuristic', () => {
    const graph = model(
      [node('FnA', 'AWS::Lambda::Function'), node('FnB', 'AWS::Lambda::Function')],
      [refEdge('FnA', 'FnB', ['Environment', 'Variables', 'PEER_FN_ARN'])],
    );
    const arch = generate(graph);
    const assoc = arch.edges.find((e) => e.kind === 'association');
    expect(assoc).toBeDefined();
    expect(assoc!.confidence).toBe('heuristic'); // flagged — NOT asserted to be the "correct" direction
  });
});
