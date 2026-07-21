import { basename, dirname, extname } from 'node:path';

/**
 * Filename stems that carry no stack-identifying information on their own
 * (every sibling template in a multi-file layout might share this exact
 * name — confirmed against `examples/03-multi-stack-ecs-fargate`, whose
 * three sibling templates are all literally named `template.yaml`).
 */
const GENERIC_STEMS = new Set(['template']);

/** Strips a further `.template` suffix, e.g. `root.template` -> `root`. */
function stripTemplateSuffix(stem: string): string {
  const suffix = '.template';
  return stem.toLowerCase().endsWith(suffix) ? stem.slice(0, stem.length - suffix.length) : stem;
}

/**
 * Derives an assumed `AWS::StackName` value from a template's file path —
 * there is no real deploy-time stack name to read (PO Question 4b), so this
 * picks a value that's at least *stable and distinct* across sibling
 * templates, for cross-stack export-name matching purposes. Always an
 * assumption, never deployed truth — callers must label it as such.
 *
 * Two real fixture layouts drove this specific rule, verified against both:
 * `examples/03-multi-stack-ecs-fargate`'s three sibling templates are all
 * named `template.yaml` (only their containing folder distinguishes them),
 * while `examples/06-nested-stack-quickstart`'s three sibling templates
 * share one folder (only their filename distinguishes them). So: strip the
 * extension and a trailing `.template` suffix; if what's left is the
 * generic word `template`, fall back to the containing folder's name
 * instead of using the (indistinct) filename.
 */
export function assumedStackName(file: string): string {
  const base = basename(file);
  const ext = extname(base);
  const withoutExt = ext.length > 0 ? base.slice(0, base.length - ext.length) : base;
  const stem = stripTemplateSuffix(withoutExt);

  if (GENERIC_STEMS.has(stem.toLowerCase())) {
    return basename(dirname(file));
  }
  return stem;
}
