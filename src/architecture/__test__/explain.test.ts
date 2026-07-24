import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { explainReport } from '../explain.js';
import { generate } from '../generate.js';
import { loadTemplates } from '../../parser/loader.js';
import { mergeGraphs } from '../../graph/merge.js';
import type { ResolvedValue } from '../../common/types.js';
import type { GraphModel, GraphNode } from '../../common/interfaces.js';

/**
 * Ticket A.10 — `--explain` report generation (spec: "this is what turns
 * rule-table growth into a demand-driven loop instead of speculative
 * guessing"). The report must account for every source node's
 * `AbstractionDecision` exactly once, plus list `unknownTypes` ranked by
 * frequency (already sorted by `generate()` — the report must not re-sort).
 */

function node(logicalId: string, type: string, properties?: ResolvedValue): GraphNode {
  return {
    id: `test.yaml#${logicalId}`,
    logicalId,
    type,
    file: 'test.yaml',
    pos: { file: 'test.yaml', line: 3, column: 1 },
    properties,
    inclusion: { kind: 'included' },
  };
}

function model(nodes: GraphNode[]): GraphModel {
  return { nodes, edges: [], warnings: [] };
}

describe('explainReport — completeness', () => {
  test('every AbstractionDecision appears exactly once, by nodeId', () => {
    const graph = model([node('Fn', 'AWS::Lambda::Function'), node('Role', 'AWS::IAM::Role')]);
    const arch = generate(graph);
    const report = explainReport(arch);

    for (const decision of arch.decisions) {
      const occurrences = report.split('\n').filter((line) => line.includes(decision.nodeId)).length;
      expect(occurrences, `expected exactly one line for ${decision.nodeId}`).toBe(1);
    }
    expect(arch.decisions.length).toBeGreaterThan(0);
  });

  test('the synthetic Internet/Users node (Ticket A.9) is NOT double-reported as a source-node decision — it has none', () => {
    const sg = node(
      'PublicSg',
      'AWS::EC2::SecurityGroup',
      { kind: 'object', entries: [{ key: 'SecurityGroupIngress', value: { kind: 'list', items: [{ kind: 'object', entries: [{ key: 'CidrIp', value: { kind: 'scalar', value: '0.0.0.0/0' } }] }] } }] },
    );
    const owner = node('Alb', 'AWS::ElasticLoadBalancingV2::LoadBalancer');
    const arch = generate(model([sg, owner]));
    const report = explainReport(arch);

    // Every real decision still gets exactly one line...
    for (const decision of arch.decisions) {
      expect(report.split('\n').filter((line) => line.includes(decision.nodeId)).length).toBe(1);
    }
    // ...and the synthetic node, which has NO decision in arch.decisions,
    // is still visible in the report (it's a real box on the diagram) but
    // doesn't inflate the decision count.
    expect(arch.decisions.some((d) => d.nodeId === 'synthetic:internet-users')).toBe(false);
  });

  test('unknownTypes is listed in the SAME order generate() already ranked it — the report must not re-sort', () => {
    const graph = model([node('A', 'Some::Unknown::TypeA'), node('B', 'Some::Unknown::TypeA'), node('C', 'Some::Unknown::TypeB')]);
    const arch = generate(graph);
    const report = explainReport(arch);

    const idx = arch.unknownTypes.map((t) => report.indexOf(t));
    for (let i = 1; i < idx.length; i++) {
      expect(idx[i]).toBeGreaterThan(idx[i - 1]!);
    }
    expect(arch.unknownTypes.length).toBeGreaterThan(0);
  });

  test('a graph with no unknown types reports that honestly (no dangling "unknown types" section listing nothing useful)', () => {
    const graph = model([node('Fn', 'AWS::Lambda::Function')]);
    const arch = generate(graph);
    expect(arch.unknownTypes).toEqual([]);
    const report = explainReport(arch);
    expect(report).toContain('0 unknown');
  });
});

describe('explainReport — real fixture', () => {
  const EXAMPLES_DIR = fileURLToPath(new URL('../../../examples/', import.meta.url));

  test('01-simple-lambda: report accounts for both resources (Function kept, Role absorbed)', () => {
    const { templates } = loadTemplates([EXAMPLES_DIR + '01-simple-lambda/template.yaml']);
    const graph = mergeGraphs(templates);
    const arch = generate(graph);
    const report = explainReport(arch);

    for (const decision of arch.decisions) {
      expect(report).toContain(decision.nodeId);
    }
    expect(report).toContain('absorbed');
    expect(report).toContain('kept');
  });
});
