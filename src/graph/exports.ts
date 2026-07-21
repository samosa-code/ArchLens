import type { ResolvedValue } from '../common/types.js';
import type { ExportSymbolTable, ExportTableEntry, LoadedTemplate, ResolutionContext } from '../common/interfaces.js';
import { buildResolutionContext, findEntry, resolveValue } from '../parser/intrinsics.js';
import { evaluateConditions, resourceInclusion } from '../parser/conditions.js';
import { assumedStackName } from './stackName.js';

/**
 * Fixed, global assumed values for every `AWS::*` pseudo parameter except
 * `AWS::StackName` (which gets its own per-file value — see
 * `assumedStackName()`). Per PO Question 4b's refinement: a template file
 * carries no information to derive a distinct-per-file Region/AccountId/
 * etc. from, unlike a stack name, so these are one constant value shared
 * across every template being merged — consistent with these values
 * normally being shared across a whole multi-stack deployment rather than
 * varying stack to stack. `AWS::NoValue`/`AWS::NotificationARNs` are
 * deliberately absent: assuming a value for a list-typed or
 * property-removal pseudo parameter inside a string export name would be
 * meaningless, so an export name using either stays unresolved.
 */
const ASSUMED_PSEUDO_PARAMETER_PLACEHOLDERS: Readonly<Record<string, string>> = {
  'AWS::Region': 'assumed-region',
  'AWS::AccountId': 'assumed-account',
  'AWS::Partition': 'assumed-partition',
  'AWS::URLSuffix': 'assumed-urlsuffix',
  'AWS::StackId': 'assumed-stackid',
};

/**
 * Builds the per-file assumed-pseudo-parameter map (PO Question 4b), shared
 * with `graph/merge.ts` (Ticket 2.3) so both the export side and the
 * import side of cross-stack matching apply the exact same assumption.
 */
export function buildAssumedPseudoParameters(file: string): Map<string, string> {
  const map = new Map<string, string>(Object.entries(ASSUMED_PSEUDO_PARAMETER_PLACEHOLDERS));
  map.set('AWS::StackName', assumedStackName(file));
  return map;
}

/** True if `value` (recursively) contains a `pseudoParameterRef` anywhere. Shared with `graph/merge.ts`. */
export function containsPseudoParameterRef(value: ResolvedValue): boolean {
  if (value.kind === 'pseudoParameterRef') return true;
  if (value.kind === 'list') return value.items.some(containsPseudoParameterRef);
  if (value.kind === 'object') return value.entries.some((entry) => containsPseudoParameterRef(entry.value));
  return false;
}

/** Collapses a fully-resolved export-name value to one literal string, or `undefined` if it never fully collapsed. Shared with `graph/merge.ts`. */
export function collapseToMatchKey(value: ResolvedValue): string | undefined {
  return value.kind === 'scalar' && value.value !== null ? String(value.value) : undefined;
}

/** Produces a human-readable reason a resolved export-name value didn't collapse to a literal string. Shared with `graph/merge.ts`. */
export function describeUnresolvableReason(value: ResolvedValue): string {
  if (value.kind === 'unresolved') return value.reason;
  if (value.kind === 'parameterRef') return `depends on parameter "${value.name}" with no static Default`;
  if (value.kind === 'pseudoParameterRef') return `depends on pseudo parameter "${value.name}" with no assumed value`;
  if (value.kind === 'resourceRef' || value.kind === 'attributeRef' || value.kind === 'importValueRef') {
    return 'depends on another resource/value that cannot be a static literal';
  }
  if (value.kind === 'list') {
    const firstProblem = value.items.find((item) => item.kind !== 'scalar');
    return firstProblem ? describeUnresolvableReason(firstProblem) : 'did not resolve to a single literal string';
  }
  if (value.kind === 'object') return 'resolved to a plain object, not a string';
  return 'did not resolve to a single literal string';
}

/**
 * Builds the cross-stack export symbol table from N already-parsed
 * templates (Ticket 2.2). Only `Outputs` entries with an `Export.Name` are
 * indexed — a plain `Output` with no `Export` block isn't usable for
 * cross-stack `Fn::ImportValue` matching in the first place, so it's simply
 * not this table's concern.
 *
 * `Export.Name` is resolved twice per output: once with Sprint 1's normal
 * (never-guess) context, to detect whether it depends on any `AWS::*`
 * pseudo parameter at all, and — only then — again with an assumed-value
 * context (PO Question 4b) substituted in, so `usedAssumedPseudoParameters`
 * is only ever `true` when an assumption actually mattered. A plain
 * `Parameters` entry with no `Default` (not a pseudo parameter) is
 * deliberately NOT assumed either way — that's PO Question 2's existing
 * "never guess" precedent, unchanged.
 */
export function buildExportSymbolTable(templates: LoadedTemplate[]): ExportSymbolTable {
  const entries: ExportTableEntry[] = [];
  const warnings: ExportSymbolTable['warnings'] = [];

  for (const { file, ast: template } of templates) {
    const baseContext = buildResolutionContext(template);
    const conditionResults = evaluateConditions(template, baseContext);
    const plainContext: ResolutionContext = { ...baseContext, conditions: conditionResults };
    const assumedContext: ResolutionContext = { ...plainContext, assumedPseudoParameters: buildAssumedPseudoParameters(file) };

    const outputsNode = findEntry(template, 'Outputs');
    if (outputsNode?.kind !== 'object') continue;

    for (const { key: outputName, value: outputNode } of outputsNode.entries) {
      const exportNode = findEntry(outputNode, 'Export');
      if (exportNode === undefined) continue;

      const nameNode = findEntry(exportNode, 'Name');
      if (nameNode === undefined) {
        warnings.push({ kind: 'unresolvableExportName', file, outputName, reason: 'Export block has no Name' });
        continue;
      }

      const inclusion = resourceInclusion(outputNode, conditionResults);
      if (inclusion.kind === 'excluded') continue;

      const plainResolved = resolveValue(nameNode, plainContext);
      const usedAssumedPseudoParameters = containsPseudoParameterRef(plainResolved);
      const resolvedName = usedAssumedPseudoParameters ? resolveValue(nameNode, assumedContext) : plainResolved;

      const matchKey = collapseToMatchKey(resolvedName);
      if (matchKey === undefined) {
        warnings.push({ kind: 'unresolvableExportName', file, outputName, reason: describeUnresolvableReason(resolvedName) });
        continue;
      }

      const valueNode = findEntry(outputNode, 'Value');
      const value: ResolvedValue = valueNode !== undefined ? resolveValue(valueNode, plainContext) : { kind: 'unresolved', reason: 'Output has no Value' };

      entries.push({ file, outputName, matchKey, usedAssumedPseudoParameters, value, inclusion });
    }
  }

  const grouped = new Map<string, ExportTableEntry[]>();
  for (const entry of entries) {
    const existing = grouped.get(entry.matchKey);
    if (existing) {
      existing.push(entry);
    } else {
      grouped.set(entry.matchKey, [entry]);
    }
  }

  const byName = new Map<string, ExportTableEntry>();
  for (const [matchKey, group] of grouped) {
    if (group.length === 1) {
      byName.set(matchKey, group[0]!);
    } else {
      warnings.push({
        kind: 'duplicateExportName',
        matchKey,
        occurrences: group.map((entry) => ({ file: entry.file, outputName: entry.outputName })),
      });
    }
  }

  return { byName, warnings };
}
