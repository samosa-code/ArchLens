/**
 * Reads the ArchLens template-metadata convention (Ticket A.4, PO Question
 * 27): `Metadata: ArchLens: { account, region }`. CloudFormation templates
 * carry no deploy-target identity, so account/region membership is
 * *declared* per template via this key — never guessed. Templates without
 * it get no entry at all (absence, not an empty annotation), and therefore
 * no account/region boundary.
 */
import type { LoadedTemplate } from '../common/interfaces.js';
import type { AstNode } from '../common/types.js';

/** One template's declared deploy target. At least one field is present — otherwise the file has no entry in {@link FileAnnotations}. */
export interface TemplateAnnotation {
  /** Account label, verbatim from the template (e.g. `Hub (111122223333)`). */
  account?: string;
  /** Region name, verbatim from the template (e.g. `us-east-1`). */
  region?: string;
}

/** Per-file annotations, keyed by absolute template path — the shape `generate()` accepts. */
export type FileAnnotations = Map<string, TemplateAnnotation>;

/** Looks up `key` in an object-kind node; `undefined` for non-objects and missing keys. */
function objectEntry(node: AstNode | undefined, key: string): AstNode | undefined {
  if (node === undefined || node.kind !== 'object') return undefined;
  return node.entries.find((entry) => entry.key === key)?.value;
}

/** The node's string value, if it's a string scalar — anything else (including non-string scalars) is ignored, per never-guess. */
function stringScalar(node: AstNode | undefined): string | undefined {
  if (node === undefined || node.kind !== 'scalar' || typeof node.value !== 'string') return undefined;
  return node.value;
}

/**
 * Extracts every template's `Metadata.ArchLens` annotation. Malformed
 * shapes (non-object `ArchLens`, non-string values) are treated as absent
 * rather than erroring — a malformed annotation must never take the whole
 * diagram down, it just yields no boundary.
 */
export function readFileAnnotations(templates: LoadedTemplate[]): FileAnnotations {
  const annotations: FileAnnotations = new Map();
  for (const template of templates) {
    const archLens = objectEntry(objectEntry(template.ast, 'Metadata'), 'ArchLens');
    const account = stringScalar(objectEntry(archLens, 'account'));
    const region = stringScalar(objectEntry(archLens, 'region'));
    if (account === undefined && region === undefined) continue;
    annotations.set(template.file, {
      ...(account !== undefined ? { account } : {}),
      ...(region !== undefined ? { region } : {}),
    });
  }
  return annotations;
}
