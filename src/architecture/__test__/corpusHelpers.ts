/**
 * Shared real-fixture discovery for "whole corpus" tests (Ticket A.11
 * factored this out of five near-identical, independently-duplicated
 * copies in classify/connectors/reparent/rules/generate.test.ts).
 *
 * All five prior copies scanned each curated group directory with a flat,
 * non-recursive `readdirSync(dir).filter(...)` — silently missing every
 * template in `03-multi-stack-ecs-fargate` and `13-checkov-security-rule-pairs`,
 * whose templates live ONLY in subdirectories with no flat top-level file
 * at all. Both groups were being merged as empty (0-node) graphs in every
 * "whole corpus" sweep across all five files, passing vacuously rather
 * than actually exercising their content — found while building A.11's
 * `corpus-report.ts`. Centralizing the recursive walk here means the fix
 * lands once, not five times, and can't silently regress back to flat.
 */
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const EXAMPLES_DIR = fileURLToPath(new URL('../../../examples/', import.meta.url));
export const CORPUS_DIR = EXAMPLES_DIR + '14-diverse-corpus/';

/** Recursively finds every template file under `dir` — handles groups that nest templates in subdirectories with no flat top-level file at all. */
function findTemplateFilesRecursive(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = dir + entry.name;
    if (entry.isDirectory()) results.push(...findTemplateFilesRecursive(full + '/'));
    else if (/\.(ya?ml|json)$/.test(entry.name)) results.push(full);
  }
  return results;
}

/** Every template in `examples/14-diverse-corpus` (flat — no subdirectories today, but this still walks recursively for safety). */
export function corpusFiles(): string[] {
  return findTemplateFilesRecursive(CORPUS_DIR).sort();
}

/** Every curated example group (01-13, 15) — each merged as its own multi-file graph, the way the CLI would consume it. Recurses into subdirectories (03, 13). */
export function curatedExampleGroups(): { name: string; files: string[] }[] {
  return readdirSync(EXAMPLES_DIR)
    .filter((entry) => /^\d{2}-/.test(entry) && entry !== '14-diverse-corpus')
    .sort()
    .map((entry) => ({ name: entry, files: findTemplateFilesRecursive(EXAMPLES_DIR + entry + '/').sort() }));
}

/** Every template across the ENTIRE examples/ tree (14-diverse-corpus + every curated group), for sweeps that want the maximum real-fixture surface in one merge. */
export function allExampleFiles(): string[] {
  return readdirSync(EXAMPLES_DIR)
    .filter((entry) => /^\d{2}-/.test(entry))
    .sort()
    .flatMap((entry) => findTemplateFilesRecursive(EXAMPLES_DIR + entry + '/').sort());
}
