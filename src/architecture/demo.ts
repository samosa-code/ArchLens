#!/usr/bin/env node
/**
 * Sprint 3.5's manual-verification entry point — `npm run arch:demo` runs
 * the Architecture Generator against the same real 5-template set the
 * render demo (Ticket 3.2) uses, and prints what the abstraction did:
 * the raw → arch reduction, every emitted connector edge with its
 * provenance, the container tree, and sample `--explain`-style decision
 * lines. Real templates, real pipeline, no synthetic data.
 */
import { fileURLToPath } from 'node:url';
import { loadTemplates } from '../parser/loader.js';
import { mergeGraphs } from '../graph/merge.js';
import { generate } from './generate.js';
import type { ArchContainer, ArchitectureGraph } from './types.js';

const EXAMPLE_FILES = [
  '09-sam-apigw-lambda-dynamodb/template.yaml',
  '14-diverse-corpus/apigateway-lambda-integration.yaml',
  '14-diverse-corpus/rds-mysql-with-read-replica.yaml',
  '14-diverse-corpus/sam-apigw-fifo-sqs-lambda-sns.yaml',
  '02-complex-vpc-nat/template.yaml',
].map((relativePath) => fileURLToPath(new URL(`../../examples/${relativePath}`, import.meta.url)));

const shortId = (id: string): string => id.split('#').pop() ?? id;

function printContainerTree(arch: ArchitectureGraph): void {
  const children = new Map<string | undefined, ArchContainer[]>();
  for (const c of arch.containers) {
    (children.get(c.parentId) ?? children.set(c.parentId, []).get(c.parentId)!).push(c);
  }
  const nodesIn = (containerId: string) => arch.nodes.filter((n) => n.containerId === containerId);
  const walk = (parentId: string | undefined, indent: string): void => {
    for (const c of children.get(parentId) ?? []) {
      console.log(`${indent}[${c.kind}] ${c.label}${c.absorbed.length > 0 ? `  (+${c.absorbed.length} absorbed)` : ''}`);
      for (const n of nodesIn(c.id)) console.log(`${indent}  · ${n.label} (${n.service})`);
      walk(c.id, indent + '  ');
    }
  };
  walk(undefined, '  ');
}

const { templates, warnings } = loadTemplates(EXAMPLE_FILES);
for (const warning of warnings) console.error(`Failed to load ${warning.file}: ${warning.message}`);

const graph = mergeGraphs(templates);
const arch = generate(graph);

console.log('=== ArchLens Architecture Generator demo (real 5-template merge) ===\n');
console.log(
  `Raw graph: ${graph.nodes.length} resources, ${graph.edges.length} edges` +
    `\nArch graph: ${arch.stats.componentCount} components + ${arch.containers.length} containers` +
    ` (${arch.stats.absorbedCount} resources absorbed, ${arch.stats.connectorEdgeCount} connector edges recovered)\n`,
);

console.log('--- Components by layer ---');
const byLayer = new Map<string, string[]>();
for (const n of arch.nodes) {
  (byLayer.get(n.layer) ?? byLayer.set(n.layer, []).get(n.layer)!).push(`${n.label} (${n.service}${n.absorbed.length > 0 ? `, +${n.absorbed.length} absorbed` : ''})`);
}
for (const [layer, labels] of [...byLayer].sort()) {
  console.log(`  ${layer}: ${labels.join(', ')}`);
}

console.log('\n--- Container tree ---');
printContainerTree(arch);

const describeProvenance = (p: (typeof arch.edges)[number]['derivedFrom'][number]): string => {
  if (p.kind === 'connector') return `${shortId(p.viaNodeId ?? '?')} [${p.viaResourceType?.split('::').pop() ?? '?'}]`;
  if (p.kind === 'reference' || p.kind === 'crossStackImport') return `${p.kind === 'crossStackImport' ? 'import' : 'ref'} @ ${(p.propertyPath ?? []).join('.')}`;
  return p.kind;
};
const printEdges = (edges: typeof arch.edges): void => {
  for (const edge of edges) {
    const flags = [edge.inferred ? 'inferred' : undefined, edge.confidence === 'heuristic' ? 'heuristic' : undefined].filter((f) => f !== undefined);
    console.log(
      `  ${shortId(edge.source)} —${edge.label ?? edge.kind}→ ${shortId(edge.target)}  (${edge.kind}, ${edge.delivery}${flags.length > 0 ? `, ${flags.join('+')}` : ''}; via ${edge.derivedFrom.map(describeProvenance).join(', ')})`,
    );
  }
};

console.log('\n--- Connector-derived edges (would not exist in a raw dependency graph) ---');
printEdges(arch.edges.filter((e) => e.derivedFrom.some((p) => p.kind === 'connector')));

console.log('\n--- Reparented reference edges (surviving component relationships) ---');
printEdges(arch.edges.filter((e) => e.kind === 'association' && !e.derivedFrom.some((p) => p.kind === 'connector')));

const containment = arch.edges.filter((e) => e.kind === 'containment');
console.log(`\n--- Containment edges: ${containment.length} (rendered as nesting, not arrows) ---`);

console.log('\n--- Pass 6 (direction inference): edges flipped or flagged relative to the template ---');
printEdges(arch.edges.filter((e) => e.derivedFrom.every((p) => p.kind !== 'synthetic') && (e.inferred || e.confidence === 'heuristic')));

console.log('\n--- Synthetic nodes (Ticket A.9): not present in any template ---');
const syntheticNode = arch.nodes.find((n) => n.inferred === true);
if (syntheticNode !== undefined) {
  console.log(`  [${syntheticNode.id}] ${syntheticNode.label} — ${syntheticNode.decision.reason}`);
  printEdges(arch.edges.filter((e) => e.source === syntheticNode.id));
} else {
  console.log('  (none — no public ingress path detected in this merge)');
}

console.log('\n--- Sample --explain lines (one per decision action) ---');
const seen = new Set<string>();
for (const d of arch.decisions) {
  if (seen.has(d.action)) continue;
  seen.add(d.action);
  console.log(`  [${d.action}] ${shortId(d.nodeId)}: ${d.reason}`);
}

if (arch.unknownTypes.length > 0) {
  console.log(`\n--- Unknown types (rule-table worklist, most frequent first) ---\n  ${arch.unknownTypes.join(', ')}`);
}
