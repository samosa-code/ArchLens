import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { loadTemplates } from '../../parser/loader.js';
import { mergeGraphs } from '../../graph/merge.js';
import { classify, type NodeClassification } from '../classify.js';
import { resolveOwnership } from '../ownership.js';
import type { GraphEdge, GraphNodeId, ResolvedValue } from '../../common/types.js';
import type { GraphModel, GraphNode } from '../../common/interfaces.js';
import type { TypeRule } from '../types.js';

/**
 * Ticket A.5 — Pass 3 (ownership resolution): rule-declared neighbour
 * search → naming convention → transitive chase (depth-capped,
 * cycle-detected). Unit tests per strategy here; the real-fixture
 * IAM-Policy chain and corpus accounting live in `generate.test.ts` and
 * at the bottom of this file.
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

function edge(sourceLogicalId: string, targetLogicalId: string): GraphEdge {
  return {
    kind: 'reference',
    source: `test.yaml#${sourceLogicalId}`,
    target: `test.yaml#${targetLogicalId}`,
    propertyPath: ['X'],
    via: { kind: 'ref' },
  };
}

function model(nodes: GraphNode[], edges: GraphEdge[]): GraphModel {
  return { nodes, edges, warnings: [] };
}

function stringProps(props: Record<string, string>): ResolvedValue {
  return {
    kind: 'object',
    entries: Object.entries(props).map(([key, value]) => ({ key, value: { kind: 'scalar', value } })),
  };
}

function resolveWithRealRules(graph: GraphModel) {
  return resolveOwnership(graph, classify(graph).classifications);
}

describe('resolveOwnership — strategy 1: rule-declared neighbour search', () => {
  test('IAM Role next to the Lambda that references it: resolved directly, rule confidence', () => {
    const graph = model(
      [node('Role', 'AWS::IAM::Role'), node('Fn', 'AWS::Lambda::Function')],
      [edge('Fn', 'Role')], // Lambda's Role property — neighbour search is both directions
    );
    expect(resolveWithRealRules(graph).get('test.yaml#Role')).toMatchObject({
      kind: 'resolved',
      ownerId: 'test.yaml#Fn',
      strategy: 'rule-neighbour',
      confidence: 'rule',
    });
  });

  test('candidate priority order beats edge order: a LaunchTemplate next to both an ASG and an Instance goes to the ASG (first candidate type)', () => {
    const graph = model(
      [node('Tpl', 'AWS::EC2::LaunchTemplate'), node('Server', 'AWS::EC2::Instance'), node('Asg', 'AWS::AutoScaling::AutoScalingGroup')],
      [
        edge('Server', 'Tpl'), // instance ref comes first in edge order — must not win
        edge('Asg', 'Tpl'),
      ],
    );
    expect(resolveWithRealRules(graph).get('test.yaml#Tpl')).toMatchObject({
      kind: 'resolved',
      ownerId: 'test.yaml#Asg',
      strategy: 'rule-neighbour',
    });
  });

  test('a detail-typed candidate neighbour is chased to its own owner (LogStream → LogGroup → Lambda), reported as transitive', () => {
    const graph = model(
      [node('Stream', 'AWS::Logs::LogStream'), node('Group', 'AWS::Logs::LogGroup'), node('Fn', 'AWS::Lambda::Function')],
      [edge('Stream', 'Group'), edge('Group', 'Fn')],
    );
    const resolutions = resolveWithRealRules(graph);
    expect(resolutions.get('test.yaml#Group')).toMatchObject({ kind: 'resolved', ownerId: 'test.yaml#Fn' });
    expect(resolutions.get('test.yaml#Stream')).toMatchObject({
      kind: 'resolved',
      ownerId: 'test.yaml#Fn',
      strategy: 'transitive',
      confidence: 'rule',
    });
  });
});

describe('resolveOwnership — strategy 2: naming convention (ownerByNamePattern)', () => {
  test('an edgeless LogGroup with a literal /aws/lambda/... name resolves to the matching function by logical ID, heuristic confidence', () => {
    const graph = model(
      [node('Logs', 'AWS::Logs::LogGroup', stringProps({ LogGroupName: '/aws/lambda/MyFn' })), node('MyFn', 'AWS::Lambda::Function')],
      [],
    );
    expect(resolveWithRealRules(graph).get('test.yaml#Logs')).toMatchObject({
      kind: 'resolved',
      ownerId: 'test.yaml#MyFn',
      strategy: 'name-pattern',
      confidence: 'heuristic',
    });
  });

  test('matches via the owner\'s *Name property when logical IDs differ', () => {
    const graph = model(
      [
        node('Logs', 'AWS::Logs::LogGroup', stringProps({ LogGroupName: '/aws/lambda/my-api-fn' })),
        node('ApiFunction', 'AWS::Lambda::Function', stringProps({ FunctionName: 'my-api-fn' })),
      ],
      [],
    );
    expect(resolveWithRealRules(graph).get('test.yaml#Logs')).toMatchObject({ kind: 'resolved', ownerId: 'test.yaml#ApiFunction' });
  });

  test('two candidates matching the same name: ambiguous — never guessed, unresolved', () => {
    const graph = model(
      [
        node('Logs', 'AWS::Logs::LogGroup', stringProps({ LogGroupName: '/aws/lambda/dup' })),
        node('FnA', 'AWS::Lambda::Function', stringProps({ FunctionName: 'dup' })),
        node('FnB', 'AWS::Lambda::Function', stringProps({ FunctionName: 'dup' })),
      ],
      [],
    );
    expect(resolveWithRealRules(graph).get('test.yaml#Logs')).toMatchObject({ kind: 'unresolved' });
  });

  test('the {service} segment gates candidates: /aws/lambda/X never matches a DynamoDB table named X', () => {
    const graph = model(
      [node('Logs', 'AWS::Logs::LogGroup', stringProps({ LogGroupName: '/aws/lambda/Orders' })), node('Orders', 'AWS::DynamoDB::Table')],
      [],
    );
    expect(resolveWithRealRules(graph).get('test.yaml#Logs')).toMatchObject({ kind: 'unresolved' });
  });
});

describe('resolveOwnership — strategy 3: transitive over detail-only neighbourhoods, cycle detection, depth cap', () => {
  /** Hand-built classifications with fake rules, for shapes the real table deliberately cannot express (cycles, deep chains). */
  function fakeDetailClassifications(entries: { logicalId: string; absorbInto: string[] }[], components: string[]): Map<GraphNodeId, NodeClassification> {
    const map = new Map<GraphNodeId, NodeClassification>();
    for (const { logicalId, absorbInto } of entries) {
      const rule: TypeRule = { role: 'detail', group: 'plumbing', absorbInto };
      map.set(`test.yaml#${logicalId}`, { kind: 'rule', role: 'detail', rule, ruleName: `rule:Fake::${logicalId}` });
    }
    for (const logicalId of components) {
      map.set(`test.yaml#${logicalId}`, {
        kind: 'rule',
        role: 'component',
        rule: { role: 'component', layer: 'compute', service: 'fake' },
        ruleName: `rule:Fake::Component`,
      });
    }
    return map;
  }

  test('two details each naming the other as owner: cycle-detected, both unresolved with a cycle reason', () => {
    const graph = model([node('A', 'Fake::A'), node('B', 'Fake::B')], [edge('A', 'B'), edge('B', 'A')]);
    const classifications = fakeDetailClassifications(
      [
        { logicalId: 'A', absorbInto: ['Fake::B'] },
        { logicalId: 'B', absorbInto: ['Fake::A'] },
      ],
      [],
    );
    // The fake types must be resolvable by type name from the graph, so
    // node('A').type is 'Fake::A' and absorbInto targets use those names.
    const resolutions = resolveOwnership(graph, classifications);
    expect(resolutions.get('test.yaml#A')).toMatchObject({ kind: 'unresolved' });
    expect((resolutions.get('test.yaml#A') as { reason: string }).reason).toMatch(/cycl/i);
    expect(resolutions.get('test.yaml#B')).toMatchObject({ kind: 'unresolved' });
  });

  test('a 6-hop chain exceeds the depth cap of 5 and is reported as depth-exceeded, not silently dropped or resolved', () => {
    const chain = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6'];
    const graph = model(
      [...chain.map((id) => node(id, `Fake::${id}`)), node('Comp', 'Fake::Component')],
      [...chain.slice(0, -1).map((id, i) => edge(id, chain[i + 1]!)), edge('D6', 'Comp')],
    );
    const classifications = fakeDetailClassifications(
      chain.map((id, i) => ({ logicalId: id, absorbInto: i < chain.length - 1 ? [`Fake::${chain[i + 1]!}`] : ['Fake::Component'] })),
      ['Comp'],
    );
    const resolutions = resolveOwnership(graph, classifications);
    expect(resolutions.get('test.yaml#D1')).toMatchObject({ kind: 'depth-exceeded' });
    // Later links in the chain are within the cap and resolve normally.
    expect(resolutions.get('test.yaml#D3')).toMatchObject({ kind: 'resolved', ownerId: 'test.yaml#Comp' });
  });

  test('transitive with two detail neighbours that resolve to DIFFERENT owners: ambiguous, unresolved (err noisy)', () => {
    const graph = model(
      [node('X', 'Fake::X'), node('P', 'Fake::P'), node('Q', 'Fake::Q'), node('CompA', 'Fake::Component'), node('CompB', 'Fake::Component')],
      [edge('X', 'P'), edge('X', 'Q'), edge('P', 'CompA'), edge('Q', 'CompB')],
    );
    const classifications = fakeDetailClassifications(
      [
        { logicalId: 'X', absorbInto: ['Fake::None'] }, // no candidate matches — forces the transitive path
        { logicalId: 'P', absorbInto: ['Fake::Component'] },
        { logicalId: 'Q', absorbInto: ['Fake::Component'] },
      ],
      ['CompA', 'CompB'],
    );
    expect(resolveOwnership(graph, classifications).get('test.yaml#X')).toMatchObject({ kind: 'unresolved' });
  });

  test('transitive with detail neighbours agreeing on ONE owner: resolved', () => {
    const graph = model(
      [node('X', 'Fake::X'), node('P', 'Fake::P'), node('Q', 'Fake::Q'), node('Comp', 'Fake::Component')],
      [edge('X', 'P'), edge('X', 'Q'), edge('P', 'Comp'), edge('Q', 'Comp')],
    );
    const classifications = fakeDetailClassifications(
      [
        { logicalId: 'X', absorbInto: ['Fake::None'] },
        { logicalId: 'P', absorbInto: ['Fake::Component'] },
        { logicalId: 'Q', absorbInto: ['Fake::Component'] },
      ],
      ['Comp'],
    );
    expect(resolveOwnership(graph, classifications).get('test.yaml#X')).toMatchObject({
      kind: 'resolved',
      ownerId: 'test.yaml#Comp',
      strategy: 'transitive',
    });
  });

  test('a heuristic-classified detail resolves to its single non-detail neighbour', () => {
    // 'AWS::EC2::VolumeAttachment' is real, unruled, and suffix-matches
    // 'Attachment' — Ticket A.11 gave 'AWS::IoT::*PrincipalAttachment' an
    // explicit rule, so this test moved to a type that still exercises
    // the heuristic fallback.
    const graph = model(
      [node('Attach', 'AWS::EC2::VolumeAttachment'), node('Server', 'AWS::EC2::Instance')],
      [edge('Attach', 'Server')],
    );
    expect(resolveWithRealRules(graph).get('test.yaml#Attach')).toMatchObject({
      kind: 'resolved',
      ownerId: 'test.yaml#Server',
      strategy: 'heuristic-neighbour',
      confidence: 'heuristic',
    });
  });
});

describe('resolveOwnership — the real-fixture transitive chain (Ticket A.5 AC)', () => {
  test('cfngoat: EC2Policy → EC2Role → (EC2Profile →) DBAppInstance — the IAM-policy chain resolves through two absorbable hops on a real template', () => {
    const FIXTURE = fileURLToPath(new URL('../../../examples/07-vulnerable-cfngoat/cfngoat.yaml', import.meta.url));
    const { templates } = loadTemplates([FIXTURE]);
    const graph = mergeGraphs(templates);
    const resolutions = resolveOwnership(graph, classify(graph).classifications);

    const instance = `${FIXTURE}#DBAppInstance`;
    expect(resolutions.get(`${FIXTURE}#EC2Profile`)).toMatchObject({ kind: 'resolved', ownerId: instance });
    expect(resolutions.get(`${FIXTURE}#EC2Role`)).toMatchObject({ kind: 'resolved', ownerId: instance, strategy: 'transitive' });
    // The connector-role policy's ownership resolves through the role —
    // A.6 uses this as its degraded-detail absorption target.
    expect(resolutions.get(`${FIXTURE}#EC2Policy`)).toMatchObject({ kind: 'resolved', ownerId: instance, strategy: 'transitive' });
  });
});
