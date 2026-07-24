import { describe, expect, test } from 'vitest';
import { loadTemplates } from '../../parser/loader.js';
import { mergeGraphs } from '../../graph/merge.js';
import { generate } from '../generate.js';
import { readFileAnnotations } from '../metadata.js';
import { corpusFiles, curatedExampleGroups, EXAMPLES_DIR } from './corpusHelpers.js';
import type { GraphModel } from '../../common/interfaces.js';

/**
 * Ticket A.1's accounting invariant, asserted everywhere: every GraphModel
 * node appears in `decisions` exactly once — the audit log accounts for
 * every input resource, none dropped, none double-counted. This is the
 * "never discards, only hides with provenance" principle (spec §3) in its
 * testable form, and later tickets (A.3+) must keep it holding as the
 * placeholder classification is replaced with the real six-pass pipeline.
 */
function expectAccountingInvariant(graph: GraphModel): void {
  const arch = generate(graph);

  expect(arch.decisions.length).toBe(graph.nodes.length);
  const decidedIds = new Set(arch.decisions.map((d) => d.nodeId));
  expect(decidedIds.size).toBe(graph.nodes.length);
  for (const node of graph.nodes) {
    expect(decidedIds.has(node.id)).toBe(true);
  }

  expect(arch.stats.sourceNodeCount).toBe(graph.nodes.length);
  // The stats must themselves account for every decision: what's shown as a
  // component/container plus what's absorbed/converted must cover the input.
  expect(arch.stats.componentCount).toBe(arch.nodes.length);
  // absorbedCount is what "N details hidden" shows: every resource that
  // landed in some absorbed[] panel — plain details plus connectors that
  // were converted to edges and recorded on their owner.
  expect(arch.stats.absorbedCount).toBe(
    arch.decisions.filter((d) => d.action === 'absorbed' || (d.action === 'converted-to-edge' && d.absorbedInto !== undefined)).length,
  );
  // connectorEdgeCount counts (deduped) edges recovered from connector
  // resources — edges carrying at least one connector provenance entry.
  expect(arch.stats.connectorEdgeCount).toBe(arch.edges.filter((e) => e.derivedFrom.some((p) => p.kind === 'connector')).length);
  // The nodeIndex accounts for every input node (Sprint 6/7's lookup).
  expect(Object.keys(arch.nodeIndex)).toHaveLength(graph.nodes.length);
}

describe('generate() accounting invariant — every GraphModel node gets exactly one AbstractionDecision', () => {
  describe('across all 67 diverse-corpus templates, individually', () => {
    for (const file of corpusFiles()) {
      test(file.split(/[\\/]/).pop()!, () => {
        const { templates } = loadTemplates([file]);
        expectAccountingInvariant(mergeGraphs(templates));
      });
    }
  });

  describe('across every curated example group (01-13), merged per group', () => {
    for (const group of curatedExampleGroups()) {
      test(group.name, () => {
        // loadTemplates skips malformed files with a warning (PO Question 3)
        // — 05-malformed-and-missing-ref exercises exactly that; the
        // invariant must hold over whatever validly loaded.
        const { templates } = loadTemplates(group.files);
        expectAccountingInvariant(mergeGraphs(templates));
      });
    }
  });

  test('the whole 67-template corpus merged at once', () => {
    const { templates } = loadTemplates(corpusFiles());
    const graph = mergeGraphs(templates);
    expect(graph.nodes.length).toBeGreaterThan(500);
    expectAccountingInvariant(graph);
  });
});

describe('generate() containers (Ticket A.4 — Pass 2)', () => {
  test('06-nested-stack-quickstart: subnet containers nest inside the vpc container; stack resources become stack containers; container nodes leave the node list', () => {
    const dir = EXAMPLES_DIR + '06-nested-stack-quickstart/';
    const { templates } = loadTemplates([dir + 'root.template.yaml', dir + 'vpc-child.template.yaml', dir + 'bastion-child.template.yaml']);
    const graph = mergeGraphs(templates);
    const arch = generate(graph);

    // vpc-child declares 1 VPC + 12 subnets, every subnet via `VpcId: !Ref VPC`.
    const vpcs = arch.containers.filter((c) => c.kind === 'vpc');
    const subnets = arch.containers.filter((c) => c.kind === 'subnet');
    expect(vpcs).toHaveLength(1);
    expect(subnets).toHaveLength(12);
    for (const subnet of subnets) {
      expect(subnet.parentId).toBe(vpcs[0]!.id);
    }
    // root declares VPCStack + BastionStack. (Their child-template contents
    // cannot be attached statically — TemplateURL points at remote S3 URLs,
    // not local files. Documented limitation, revisited in A.11.)
    expect(arch.containers.filter((c) => c.kind === 'stack')).toHaveLength(2);

    // Container-role nodes are containers now, not boxes — and their
    // decisions say so.
    const containerNodeIds = new Set(arch.containers.map((c) => c.sourceNodeId).filter((id) => id !== undefined));
    expect(arch.nodes.some((n) => containerNodeIds.has(n.id))).toBe(false);
    for (const id of containerNodeIds) {
      const decision = arch.decisions.find((d) => d.nodeId === id)!;
      expect(decision.action).toBe('promoted-to-container');
    }
    // The accounting invariant still holds with containers split out.
    expect(arch.decisions.length).toBe(graph.nodes.length);
    expect(arch.stats.componentCount).toBe(arch.nodes.length);
  });

  test('15-multi-account-hub-spoke: the full account → region → vpc → subnet chain from the synthetic fixture (PO Questions 20/27)', () => {
    const dir = EXAMPLES_DIR + '15-multi-account-hub-spoke/';
    const files = [dir + 'hub-eventbus.yaml', dir + 'spoke-app-us.yaml', dir + 'spoke-app-eu.yaml'];
    const { templates } = loadTemplates(files);
    const graph = mergeGraphs(templates);
    const arch = generate(graph, { fileAnnotations: readFileAnnotations(templates) });

    const byKind = (kind: string) => arch.containers.filter((c) => c.kind === kind);
    expect(byKind('account').map((c) => c.label).sort()).toEqual(['Hub (111122223333)', 'Spoke (444455556666)']);
    expect(byKind('region')).toHaveLength(3); // Hub/us-east-1, Spoke/us-east-1, Spoke/eu-west-1

    const spoke = byKind('account').find((c) => c.label === 'Spoke (444455556666)')!;
    const spokeUs = byKind('region').find((c) => c.parentId === spoke.id && c.label === 'us-east-1')!;
    const vpc = byKind('vpc')[0]!;
    const subnet = byKind('subnet')[0]!;
    expect(vpc.parentId).toBe(spokeUs.id);
    expect(subnet.parentId).toBe(vpc.id);

    const nodeByLogicalId = (logicalId: string) => arch.nodes.find((n) => n.label === logicalId)!;
    expect(nodeByLogicalId('AppServer').containerId).toBe(subnet.id);
    const hub = byKind('account').find((c) => c.label === 'Hub (111122223333)')!;
    const hubUs = byKind('region').find((c) => c.parentId === hub.id)!;
    expect(nodeByLogicalId('CentralBus').containerId).toBe(hubUs.id);
    const spokeEu = byKind('region').find((c) => c.parentId === spoke.id && c.label === 'eu-west-1')!;
    expect(nodeByLogicalId('ReplicaFunction').containerId).toBe(spokeEu.id);

    // Without annotations, the same graph gets no account/region containers
    // (spec §8: boundaries only when the set provably spans).
    const plain = generate(graph);
    expect(plain.containers.some((c) => c.kind === 'account' || c.kind === 'region')).toBe(false);
  });
});

describe('generate() with classification (Ticket A.3) and absorption (Ticket A.5)', () => {
  test('ruled components get their rule\'s layer/service with rule confidence; the IAM Role is absorbed into its Lambda', () => {
    const { templates } = loadTemplates([EXAMPLES_DIR + '01-simple-lambda/template.yaml']);
    const graph = mergeGraphs(templates);
    const arch = generate(graph);

    // Two resources: the Lambda stays a box; its Role is absorbed into it.
    expect(arch.nodes).toHaveLength(1);

    const fn = arch.nodes.find((n) => n.resourceType === 'AWS::Lambda::Function')!;
    expect(fn.layer).toBe('compute');
    expect(fn.service).toBe('lambda');
    expect(fn.decision.action).toBe('kept');
    expect(fn.decision.confidence).toBe('rule');
    expect(fn.decision.rule).toBe('rule:AWS::Lambda::Function');
    // Ticket 3.3's detail panel needs "template.yaml:42 + View source" —
    // carried on the ArchNode itself, not just on absorbed resources.
    expect(fn.file).toContain('01-simple-lambda');
    expect(fn.line).toBeGreaterThan(1);

    // The Role's fate: absorbed into the Lambda, recorded fully.
    const roleDecision = arch.decisions.find((d) => d.nodeId.endsWith('#LambdaRole'))!;
    expect(roleDecision.action).toBe('absorbed');
    expect(roleDecision.absorbedInto).toBe(fn.id);
    expect(fn.absorbed).toHaveLength(1);
    expect(fn.absorbed[0]).toMatchObject({
      logicalId: 'LambdaRole',
      resourceType: 'AWS::IAM::Role',
      group: 'permissions',
    });
    // Click-to-source survives absorption: real file + line carried along.
    expect(fn.absorbed[0]!.file).toContain('01-simple-lambda');
    expect(fn.absorbed[0]!.line).toBeGreaterThan(1);
    expect(arch.stats.absorbedCount).toBe(1);

    // Every type here is ruled — nothing unknown to report.
    expect(arch.unknownTypes).toEqual([]);
  });

  test('connectors flow end-to-end (apigateway-lambda-integration): converted-to-edge decisions, arch edges present, connector absorbed into its owner\'s panel', () => {
    const FIXTURE = EXAMPLES_DIR + '14-diverse-corpus/apigateway-lambda-integration.yaml';
    const { templates } = loadTemplates([FIXTURE]);
    const graph = mergeGraphs(templates);
    const arch = generate(graph);

    const methodDecision = arch.decisions.find((d) => d.nodeId.endsWith('#ApiMethod'))!;
    expect(methodDecision.action).toBe('converted-to-edge');
    expect(methodDecision.absorbedInto).toBe(`${FIXTURE}#RestApi`);

    // The RestApi's panel lists the method among its absorbed resources.
    const api = arch.nodes.find((n) => n.label === 'RestApi')!;
    expect(api.absorbed.some((a) => a.resourceType === 'AWS::ApiGateway::Method')).toBe(true);

    // The emitted edge connects the two surviving boxes.
    expect(arch.edges.some((e) => e.source === `${FIXTURE}#RestApi` && e.target === `${FIXTURE}#LambdaFunction`)).toBe(true);
    expect(arch.stats.connectorEdgeCount).toBeGreaterThan(0);
  });

  test('corpus-wide detail accounting: every detail either absorbs or stays visibly unresolved — no depth-exceeded, nothing silently dropped', () => {
    const { templates } = loadTemplates(corpusFiles());
    const graph = mergeGraphs(templates);
    const arch = generate(graph);

    // Depth-exceeded should not occur in practice (AC) — if this ever
    // fails, that's a real finding for A.11, not a test to loosen.
    expect(arch.decisions.some((d) => d.reason.includes('depth'))).toBe(false);

    // Absorption is doing real work at corpus scale.
    expect(arch.stats.absorbedCount).toBeGreaterThan(50);
    // Ticket A.9: the synthetic Internet/Users node has no source GraphModel
    // node at all — it must be excluded here, or this 1:1 accounting
    // equation (every surviving box/container/absorption traces back to
    // exactly one real input node) would spuriously fail the moment the
    // corpus contains any public-facing resource (it does).
    const realNodes = arch.nodes.filter((n) => n.inferred !== true);
    expect(realNodes.length + arch.containers.filter((c) => c.sourceNodeId !== undefined).length + arch.stats.absorbedCount).toBe(graph.nodes.length);

    // Every absorbed resource landed in exactly one absorbed[] list, with
    // its provenance intact.
    const absorbedEverywhere = [
      ...arch.nodes.flatMap((n) => n.absorbed),
      ...arch.containers.flatMap((c) => c.absorbed),
    ];
    expect(absorbedEverywhere).toHaveLength(arch.stats.absorbedCount);
    const absorbedIds = new Set(absorbedEverywhere.map((a) => a.nodeId));
    expect(absorbedIds.size).toBe(absorbedEverywhere.length);
  });

  test('unknownTypes is deduplicated and ordered by instance frequency, descending (the --explain worklist order)', () => {
    // 07-vulnerable-cfngoat + 08-cdk-synthesized both carry Custom::* and
    // niche unruled types with different instance counts.
    const groups = curatedExampleGroups().filter((g) => /^(07|08)-/.test(g.name));
    const files = groups.flatMap((g) => g.files);
    const { templates } = loadTemplates(files);
    const graph = mergeGraphs(templates);
    const arch = generate(graph);

    expect(arch.unknownTypes.length).toBeGreaterThan(0);
    expect(new Set(arch.unknownTypes).size).toBe(arch.unknownTypes.length);

    // Recompute expected counts straight from the graph and assert the
    // ordering is non-increasing.
    const counts = new Map<string, number>();
    for (const n of graph.nodes) {
      if (n.type !== undefined && arch.unknownTypes.includes(n.type)) {
        counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
      }
    }
    const listed = arch.unknownTypes.map((t) => counts.get(t) ?? 0);
    for (let i = 1; i < listed.length; i++) {
      expect(listed[i]!).toBeLessThanOrEqual(listed[i - 1]!);
    }
  });
});
