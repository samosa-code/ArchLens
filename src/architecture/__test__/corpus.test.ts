import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { loadTemplates } from '../../parser/loader.js';
import { mergeGraphs } from '../../graph/merge.js';
import { classify } from '../classify.js';
import { generate } from '../generate.js';
import { corpusFiles, curatedExampleGroups } from './corpusHelpers.js';

/**
 * Ticket A.11 — corpus validation, the ticket that matters (spec's own
 * words). Automates the acceptance criteria that can be automated; the
 * 3-fixture eyeball test (the AC's remaining piece) is manual and
 * documented in `internal-docs/SPRINT-PLAN.md`'s A.11 findings, not here —
 * "readable at a glance" isn't something a unit test can assert.
 *
 * Real numbers behind these thresholds come from
 * `npm run arch:corpus-report`, which prints the same metrics per-fixture
 * for whenever the next iteration loop back to A.2 is needed.
 */

describe('A.11 — zero crashes across every real fixture', () => {
  test('every one of the 67 examples/14-diverse-corpus templates, individually', () => {
    for (const file of corpusFiles()) {
      const { templates } = loadTemplates([file]);
      expect(() => generate(mergeGraphs(templates)), file).not.toThrow();
    }
  });

  test('every curated example group (01-13, 15), merged per group', () => {
    for (const group of curatedExampleGroups()) {
      const { templates } = loadTemplates(group.files);
      expect(() => generate(mergeGraphs(templates)), group.name).not.toThrow();
    }
  });
});

describe('A.11 — rule coverage: ≥90% of resource instances hit an explicit rule, not the fallback heuristic', () => {
  test('aggregate across the whole 14-diverse-corpus, weighted by resource instance count', () => {
    const { templates } = loadTemplates(corpusFiles());
    const graph = mergeGraphs(templates);
    const { classifications } = classify(graph);

    // Deliberately a classify()-level question ("does this TYPE have a
    // rules.ts entry?"), not `generate()`'s later ownership-resolution
    // confidence — a ruled type whose owner never resolves still reports
    // `confidence: 'fallback'` on its final decision (kept-unknown, honest
    // but unresolved), which would otherwise be misread as "no rule
    // exists" (a real methodology bug found and fixed while building this
    // ticket's report script — see the SPRINT-PLAN.md finding).
    const ruleCount = [...classifications.values()].filter((c) => c.kind === 'rule').length;
    const ruleCoverage = ruleCount / graph.nodes.length;

    expect(ruleCoverage, `rule coverage ${(ruleCoverage * 100).toFixed(1)}% — run 'npm run arch:corpus-report' for the per-fixture breakdown`).toBeGreaterThanOrEqual(0.9);
  });
});

describe('A.11 — reduction ratio', () => {
  function reductionRatio(files: string[]): number {
    const { templates } = loadTemplates(files);
    const graph = mergeGraphs(templates);
    const arch = generate(graph);
    const visibleCount = arch.nodes.filter((n) => n.inferred !== true).length;
    return graph.nodes.length > 0 ? 1 - visibleCount / graph.nodes.length : 0;
  }

  /**
   * KNOWN, DOCUMENTED DEVIATION (per the ticket's own Definition of Done:
   * "success metrics met, OR a documented, scoped follow-up"): the AC's
   * ≥85% target on SAM/serverless fixtures assumes the noise SAM normally
   * generates (execution roles, log groups, Lambda permissions, API
   * Gateway methods/deployments/stages) is present in the template for
   * this tool to absorb. It usually isn't — SAM's transform generates all
   * of that at DEPLOY time, after this tool's static parser has already
   * read the source file. `examples/14-diverse-corpus/sam-apigw-caching.yaml`
   * is the extreme case: exactly 2 resources (an Api and a Function),
   * both genuinely distinct components, zero plumbing in the template to
   * hide. Every SAM fixture here has 100% rule coverage and 0 unknown
   * types (confirmed via `npm run arch:corpus-report`) — the shortfall is
   * input sparsity, not missing rules or abstraction quality. This is
   * asserted as a floor (protects against a real regression) rather than
   * the AC's 85% (which would be asserting a false target as fact).
   */
  test('SAM/serverless fixtures aggregate ≥55% (documented shortfall vs the 85% AC — see comment above)', () => {
    // Identify SAM fixtures by the actual Transform declaration, not
    // filename — matches `corpus-report.ts`'s own detection.
    const serverlessFiles = corpusFiles().filter((f) => readFileSync(f, 'utf8').includes('AWS::Serverless-2016-10-31'));
    expect(serverlessFiles.length).toBeGreaterThan(0);

    const ratio = reductionRatio(serverlessFiles);
    expect(ratio, `SAM aggregate reduction ratio ${(ratio * 100).toFixed(1)}%`).toBeGreaterThanOrEqual(0.55);
  });
});
