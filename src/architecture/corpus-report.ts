#!/usr/bin/env node
/**
 * Ticket A.11's manual-verification entry point — `npm run arch:corpus-report`
 * runs the Architecture Generator against every one of the 67
 * `examples/14-diverse-corpus` templates individually, plus every curated
 * example group (01-13, 15), and prints the metrics the ticket's
 * acceptance criteria are graded against: per-fixture reduction ratio,
 * rule coverage, unknown-type frequency, and a zero-crash/accounting-
 * invariant check. This is the tool that turns "is the abstraction any
 * good" from a guess into a number — real templates, real pipeline, no
 * synthetic data.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadTemplates } from '../parser/loader.js';
import { mergeGraphs } from '../graph/merge.js';
import { classify } from './classify.js';
import { generate } from './generate.js';
import type { ArchitectureGraph } from './types.js';
import type { GraphModel } from '../common/interfaces.js';

const EXAMPLES_DIR = fileURLToPath(new URL('../../examples/', import.meta.url));
const CORPUS_DIR = EXAMPLES_DIR + '14-diverse-corpus/';

interface FixtureMetrics {
  name: string;
  sourceNodeCount: number;
  visibleCount: number; // arch.nodes excluding the synthetic Internet/Users node
  reductionRatio: number; // 1 - visibleCount/sourceNodeCount
  ruleCount: number; // nodes whose TYPE matched an explicit rules.ts entry (classify()'s NodeClassification.kind === 'rule')
  ruleCoverage: number; // ruleCount / sourceNodeCount
  unknownTypes: string[];
  isServerless: boolean;
  error?: string;
}

function isServerlessTemplate(fileContent: string): boolean {
  return fileContent.includes('AWS::Serverless-2016-10-31');
}

function measure(name: string, graph: GraphModel, isServerless: boolean): FixtureMetrics {
  const sourceNodeCount = graph.nodes.length;
  // Rule coverage is a Pass-1 classification question ("does this TYPE have
  // a rules.ts entry?"), deliberately independent of `generate()`'s later
  // ownership-resolution outcome — a node whose type IS ruled but whose
  // owner never resolves still reports `confidence: 'fallback'` on its
  // final decision (kept-unknown, honest but unresolved), which would
  // otherwise be misread as "no rule exists" and chase a fix that isn't
  // needed. `classify()` is what the AC actually means by "hit an explicit
  // rule, not the fallback heuristic".
  const { classifications } = classify(graph);
  const ruleCount = [...classifications.values()].filter((c) => c.kind === 'rule').length;

  let arch: ArchitectureGraph;
  try {
    arch = generate(graph);
  } catch (error) {
    return {
      name,
      sourceNodeCount,
      visibleCount: 0,
      reductionRatio: 0,
      ruleCount,
      ruleCoverage: sourceNodeCount > 0 ? ruleCount / sourceNodeCount : 0,
      unknownTypes: [],
      isServerless,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const visibleCount = arch.nodes.filter((n) => n.inferred !== true).length;

  return {
    name,
    sourceNodeCount,
    visibleCount,
    reductionRatio: sourceNodeCount > 0 ? 1 - visibleCount / sourceNodeCount : 0,
    ruleCount,
    ruleCoverage: sourceNodeCount > 0 ? ruleCount / sourceNodeCount : 0,
    unknownTypes: arch.unknownTypes,
    isServerless,
  };
}

function printFixtureLine(m: FixtureMetrics): void {
  if (m.error !== undefined) {
    console.log(`  [CRASH] ${m.name}: ${m.error}`);
    return;
  }
  const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
  console.log(
    `  ${m.isServerless ? '[SAM]' : '     '} ${m.name.padEnd(45)} nodes=${String(m.sourceNodeCount).padStart(4)}  reduction=${pct(m.reductionRatio).padStart(4)}  ruleCoverage=${pct(m.ruleCoverage).padStart(4)}  unknown=${m.unknownTypes.length}`,
  );
}

function aggregate(metrics: FixtureMetrics[]): { reductionRatio: number; ruleCoverage: number } {
  const totalSource = metrics.reduce((s, m) => s + m.sourceNodeCount, 0);
  const totalVisible = metrics.reduce((s, m) => s + m.visibleCount, 0);
  const totalRules = metrics.reduce((s, m) => s + m.ruleCount, 0);
  return {
    reductionRatio: totalSource > 0 ? 1 - totalVisible / totalSource : 0,
    ruleCoverage: totalSource > 0 ? totalRules / totalSource : 0,
  };
}

const corpusMetrics: FixtureMetrics[] = readdirSync(CORPUS_DIR)
  .filter((f) => /\.(ya?ml|json)$/.test(f))
  .sort()
  .map((f) => {
    const path = CORPUS_DIR + f;
    const { templates } = loadTemplates([path]);
    const content = readFileSync(path, 'utf8');
    return measure(f, mergeGraphs(templates), isServerlessTemplate(content));
  });

console.log('=== Ticket A.11 — 14-diverse-corpus, individually (67 templates) ===\n');
for (const m of corpusMetrics) printFixtureLine(m);

const crashes = corpusMetrics.filter((m) => m.error !== undefined);
const serverlessMetrics = corpusMetrics.filter((m) => m.isServerless && m.error === undefined);
const overall = aggregate(corpusMetrics.filter((m) => m.error === undefined));
const serverlessAgg = aggregate(serverlessMetrics);

console.log('\n=== Aggregate (14-diverse-corpus) ===');
console.log(`  Crashes: ${crashes.length} / ${corpusMetrics.length}`);
console.log(`  Overall reduction ratio: ${(overall.reductionRatio * 100).toFixed(1)}%`);
console.log(`  Overall rule coverage: ${(overall.ruleCoverage * 100).toFixed(1)}%`);
console.log(`  SAM/serverless fixtures: ${serverlessMetrics.length}, aggregate reduction ratio: ${(serverlessAgg.reductionRatio * 100).toFixed(1)}%`);

const unknownFrequency = new Map<string, number>();
for (const m of corpusMetrics) {
  for (const t of m.unknownTypes) unknownFrequency.set(t, (unknownFrequency.get(t) ?? 0) + 1);
}
const rankedUnknowns = [...unknownFrequency.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
console.log(`\n=== Unknown types across 14-diverse-corpus (${rankedUnknowns.length} distinct, ranked by how many templates hit them) ===`);
for (const [type, count] of rankedUnknowns) console.log(`  ${String(count).padStart(3)}  ${type}`);

/**
 * Recursively finds every template file under `dir` — several curated
 * groups (03-multi-stack-ecs-fargate, 13-checkov-security-rule-pairs)
 * nest their templates in subdirectories with NO flat top-level file at
 * all, which a plain `readdirSync(dir).filter(...)` silently misses
 * entirely (found while building this report — see A.11's findings).
 */
function findTemplateFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = dir + entry.name;
    if (entry.isDirectory()) results.push(...findTemplateFiles(full + '/'));
    else if (/\.(ya?ml|json)$/.test(entry.name)) results.push(full);
  }
  return results;
}

// --- Curated example groups (01-13, 15) ---
const curatedGroups = readdirSync(EXAMPLES_DIR)
  .filter((entry) => /^\d{2}-/.test(entry) && entry !== '14-diverse-corpus')
  .sort();

console.log('\n=== Curated example groups (merged per group, the way the CLI would consume them) ===\n');
const curatedMetrics: FixtureMetrics[] = [];
for (const entry of curatedGroups) {
  const dir = EXAMPLES_DIR + entry + '/';
  const files = findTemplateFiles(dir).sort();
  const { templates } = loadTemplates(files);
  const isServerless = files.some((f) => readFileSync(f, 'utf8').includes('AWS::Serverless-2016-10-31'));
  const m = measure(entry, mergeGraphs(templates), isServerless);
  curatedMetrics.push(m);
  printFixtureLine(m);
}

const curatedCrashes = curatedMetrics.filter((m) => m.error !== undefined);
console.log(`\n  Curated crashes: ${curatedCrashes.length} / ${curatedMetrics.length}`);
