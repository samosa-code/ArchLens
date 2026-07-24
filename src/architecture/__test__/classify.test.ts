import { describe, expect, test } from 'vitest';
import { loadTemplates } from '../../parser/loader.js';
import { mergeGraphs } from '../../graph/merge.js';
import { classify } from '../classify.js';
import { allExampleFiles } from './corpusHelpers.js';
import type { GraphEdge } from '../../common/types.js';
import type { GraphModel, GraphNode } from '../../common/interfaces.js';

/**
 * Ticket A.3 — Pass 1 (classification): rule lookup → structural heuristic
 * (spec §7) → kept-unknown fallback. Synthetic cases per outcome here;
 * corpus-wide accounting lives in `generate.test.ts`.
 */

/** Terse synthetic GraphNode — classification only reads `id`/`type`, the rest is structural boilerplate. */
function node(logicalId: string, type: string | undefined): GraphNode {
  return {
    id: `test.yaml#${logicalId}`,
    logicalId,
    type,
    file: 'test.yaml',
    pos: { file: 'test.yaml', line: 1, column: 1 },
    properties: undefined,
    inclusion: { kind: 'included' },
  };
}

/** A minimal `reference` edge between two synthetic nodes. */
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

describe('classify — rule lookup', () => {
  test('a ruled type gets its rule\'s role, with rule provenance', () => {
    const graph = model([node('Fn', 'AWS::Lambda::Function')], []);
    const { classifications } = classify(graph);
    const c = classifications.get('test.yaml#Fn')!;
    expect(c).toEqual({ kind: 'rule', role: 'component', ruleName: 'rule:AWS::Lambda::Function', rule: expect.anything() });
  });

  test('all four roles come through the table: container, detail, connector', () => {
    const graph = model(
      [node('Vpc', 'AWS::EC2::VPC'), node('Role', 'AWS::IAM::Role'), node('Perm', 'AWS::Lambda::Permission')],
      [],
    );
    const { classifications } = classify(graph);
    expect(classifications.get('test.yaml#Vpc')).toMatchObject({ kind: 'rule', role: 'container' });
    expect(classifications.get('test.yaml#Role')).toMatchObject({ kind: 'rule', role: 'detail' });
    expect(classifications.get('test.yaml#Perm')).toMatchObject({ kind: 'rule', role: 'connector' });
  });
});

describe('classify — structural heuristic (spec §7: suffix AND exactly one non-detail neighbour AND nothing else references it)', () => {
  // 'AWS::EC2::VolumeAttachment' is real, unruled, and suffix-matches
  // 'Attachment'. (Ticket A.11 gave 'AWS::IoT::*PrincipalAttachment' an
  // explicit rule, so those two no longer exercise this fallback — this
  // constant moved to keep testing the mechanism, not a specific type.)
  const UNRULED_PLUMBING = 'AWS::EC2::VolumeAttachment';

  test('matches: absorbed as heuristic detail into its single non-detail neighbour', () => {
    const graph = model(
      [node('Attach', UNRULED_PLUMBING), node('Instance', 'AWS::EC2::Instance')],
      [edge('Attach', 'Instance')],
    );
    const c = classify(graph).classifications.get('test.yaml#Attach')!;
    expect(c).toEqual({ kind: 'heuristic', role: 'detail', ownerId: 'test.yaml#Instance' });
  });

  test('a detail-role neighbour does not disqualify — only non-detail neighbours are counted', () => {
    // Attach → Instance (non-detail) and Attach → Role (detail rule): still exactly one non-detail neighbour.
    const graph = model(
      [node('Attach', UNRULED_PLUMBING), node('Instance', 'AWS::EC2::Instance'), node('Role', 'AWS::IAM::Role')],
      [edge('Attach', 'Instance'), edge('Attach', 'Role')],
    );
    const c = classify(graph).classifications.get('test.yaml#Attach')!;
    expect(c).toEqual({ kind: 'heuristic', role: 'detail', ownerId: 'test.yaml#Instance' });
  });

  test('no match: two non-detail neighbours (ambiguous owner — err noisy, keep visible)', () => {
    const graph = model(
      [node('Attach', UNRULED_PLUMBING), node('A', 'AWS::EC2::Instance'), node('B', 'AWS::SQS::Queue')],
      [edge('Attach', 'A'), edge('Attach', 'B')],
    );
    expect(classify(graph).classifications.get('test.yaml#Attach')).toEqual({ kind: 'unknown' });
  });

  test('no match: something else references it (inbound edge from a non-owner)', () => {
    const graph = model(
      [node('Attach', UNRULED_PLUMBING), node('Instance', 'AWS::EC2::Instance'), node('Other', 'AWS::SQS::Queue')],
      [edge('Attach', 'Instance'), edge('Other', 'Attach')],
    );
    expect(classify(graph).classifications.get('test.yaml#Attach')).toEqual({ kind: 'unknown' });
  });

  test('no match: referenced by a detail-role node (the case only condition 3 catches — a detail referencer is excluded from the neighbour count but still a reference)', () => {
    // Attach → Instance (single non-detail neighbour ✓), but Role (a
    // detail by rule) references Attach: condition 2 alone would absorb
    // it; condition 3 must reject it.
    const graph = model(
      [node('Attach', UNRULED_PLUMBING), node('Instance', 'AWS::EC2::Instance'), node('Role', 'AWS::IAM::Role')],
      [edge('Attach', 'Instance'), edge('Role', 'Attach')],
    );
    expect(classify(graph).classifications.get('test.yaml#Attach')).toEqual({ kind: 'unknown' });
  });

  test('a reference FROM the owner itself is fine (owner → plumbing is still "nothing else references it")', () => {
    const graph = model(
      [node('Attach', UNRULED_PLUMBING), node('Instance', 'AWS::EC2::Instance')],
      [edge('Instance', 'Attach')],
    );
    const c = classify(graph).classifications.get('test.yaml#Attach')!;
    expect(c).toEqual({ kind: 'heuristic', role: 'detail', ownerId: 'test.yaml#Instance' });
  });

  test('no match: only neighbour is itself a detail (zero non-detail neighbours)', () => {
    const graph = model(
      [node('Attach', UNRULED_PLUMBING), node('Role', 'AWS::IAM::Role')],
      [edge('Attach', 'Role')],
    );
    expect(classify(graph).classifications.get('test.yaml#Attach')).toEqual({ kind: 'unknown' });
  });

  test('no match: suffix does not match (structurally identical otherwise)', () => {
    // Fake, permanently-unruled type — same reasoning as 'Test::Unruled::*'
    // above: a real type here would eventually gain a rule and break this
    // negative case, exactly as 'AWS::AmazonMQ::Broker' did in Ticket A.11.
    const graph = model(
      [node('Broker', 'Test::Unruled::NoSuffixMatch'), node('Instance', 'AWS::EC2::Instance')],
      [edge('Broker', 'Instance')],
    );
    expect(classify(graph).classifications.get('test.yaml#Broker')).toEqual({ kind: 'unknown' });
  });

  test('no match: isolated node (zero neighbours) even with a matching suffix', () => {
    const graph = model([node('Attach', UNRULED_PLUMBING)], []);
    expect(classify(graph).classifications.get('test.yaml#Attach')).toEqual({ kind: 'unknown' });
  });
});

describe('classify — unknownTypeCounts (the --explain worklist)', () => {
  test('counts instances per unruled type; ruled types never appear; undeclared types cannot be listed', () => {
    const graph = model(
      [
        node('Fn', 'AWS::Lambda::Function'), // ruled — never counted
        // Fake, permanently-unruled type strings — this test is about
        // classify()'s bookkeeping mechanism, not any specific real type
        // (real types migrate from unruled to ruled as the table grows,
        // e.g. Ticket A.11 — pinning to a real type here would break the
        // next time coverage improves, exactly as it did for this test).
        node('P1', 'Test::Unruled::TypeA'),
        node('P2', 'Test::Unruled::TypeA'),
        node('Broker', 'Test::Unruled::TypeB'),
        node('NoType', undefined), // no type to report
      ],
      [],
    );
    const { unknownTypeCounts } = classify(graph);
    expect(unknownTypeCounts.get('Test::Unruled::TypeA')).toBe(2);
    expect(unknownTypeCounts.get('Test::Unruled::TypeB')).toBe(1);
    expect(unknownTypeCounts.has('AWS::Lambda::Function')).toBe(false);
    expect(unknownTypeCounts.size).toBe(2);
  });

  test('heuristic-matched types still count as unknown — the heuristic is a stopgap, not a rule; reporting them drives rule-table growth', () => {
    const graph = model(
      [node('Attach', 'AWS::EC2::VolumeAttachment'), node('Instance', 'AWS::EC2::Instance')],
      [edge('Attach', 'Instance')],
    );
    const { classifications, unknownTypeCounts } = classify(graph);
    expect(classifications.get('test.yaml#Attach')!.kind).toBe('heuristic');
    expect(unknownTypeCounts.get('AWS::EC2::VolumeAttachment')).toBe(1);
  });
});

describe('classify — full corpus integration', () => {
  test('every node classified; unknownTypes stays under the sanity ceiling (a jump here means a rule-table regression, not new fixtures)', () => {
    const { templates } = loadTemplates(allExampleFiles());
    const graph = mergeGraphs(templates);
    const { classifications, unknownTypeCounts } = classify(graph);

    expect(classifications.size).toBe(graph.nodes.length);
    // Real count at time of writing (post-Ticket-A.11 rule-table growth):
    // well under 63 unruled types across every fixture on disk (mostly
    // Custom::* resources, whose whole point is that they're arbitrary and
    // can't be given a generic rule, plus a couple of niche services). The
    // ceiling is a regression tripwire for rule-table deletions,
    // deliberately loose enough to survive modest fixture growth.
    expect(unknownTypeCounts.size).toBeGreaterThan(0);
    expect(unknownTypeCounts.size).toBeLessThan(80);
    // Spot checks: ruled types never leak in; known unruled ones do appear.
    // `Custom::*` deliberately has no rule — it's a user-defined resource
    // backed by an arbitrary Lambda; guessing its role would be exactly the
    // over-eager heuristic this project avoids (see A.11's findings).
    expect(unknownTypeCounts.has('AWS::Lambda::Function')).toBe(false);
    expect(unknownTypeCounts.has('Custom::GetFromJson')).toBe(true);
  });
});
