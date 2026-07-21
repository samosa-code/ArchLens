import type { AstNode, GraphEdge, GraphWarning } from '../common/types.js';
import type { ExportSymbolTable, ExportTableEntry, GraphModel, LoadedTemplate, ResolutionContext } from '../common/interfaces.js';
import { buildResolutionContext, findEntry, resolveValue } from '../parser/intrinsics.js';
import { evaluateConditions } from '../parser/conditions.js';
import { buildGraph, nodeId } from './model.js';
import { buildExportSymbolTable, buildAssumedPseudoParameters, collapseToMatchKey, containsPseudoParameterRef, describeUnresolvableReason } from './exports.js';
import { assumedStackName } from './stackName.js';
import { walkResolvedValueLeaves } from './resolvedValueWalk.js';

/**
 * Finds every `Fn::ImportValue` call site in a raw (unresolved) AST
 * subtree, without resolving anything — mirrors `resolveValue()`'s own
 * single-key-object dispatch check, but for structural search rather than
 * resolution, since Ticket 2.3 needs the *raw* export-name expression (to
 * try multiple candidate resolutions against it — see
 * `resolveImportCall()`), not the already-collapsed `importValueRef` Sprint
 * 1 produces.
 */
function findImportValueCalls(node: AstNode, path: string[]): { path: string[]; argNode: AstNode }[] {
  if (node.kind === 'object') {
    if (node.entries.length === 1 && node.entries[0]!.key === 'Fn::ImportValue') {
      return [{ path, argNode: node.entries[0]!.value }];
    }
    return node.entries.flatMap(({ key, value }) => findImportValueCalls(value, [...path, key]));
  }
  if (node.kind === 'array') {
    return node.items.flatMap((item, index) => findImportValueCalls(item, [...path, String(index)]));
  }
  return [];
}

/** A synthetic AST scalar node, for `buildCandidateContext()`'s forced parameter substitution — never derived from real source, so its position is a placeholder. */
function syntheticScalarNode(value: string): AstNode {
  return { kind: 'scalar', value, pos: { file: '<assumed>', line: 0, column: 0 } };
}

/**
 * Builds a resolution context (PO Question 4f) where every `Parameters`
 * entry — regardless of its own real `Default` — resolves to
 * `candidateStackName` instead. Used only to re-resolve one small
 * `Fn::ImportValue` export-name expression at a time, never for ordinary
 * `Properties` resolution, so forcing every parameter to one value is
 * safely scoped rather than corrupting anything else.
 */
function buildCandidateContext(base: ResolutionContext, candidateStackName: string): ResolutionContext {
  const overriddenParameters = new Map<string, AstNode | undefined>();
  for (const name of base.parameters.keys()) {
    overriddenParameters.set(name, syntheticScalarNode(candidateStackName));
  }
  return { ...base, parameters: overriddenParameters };
}

type ImportResolution = {
  matchKey: string;
  entry: ExportTableEntry;
  matchedVia: 'exact' | 'assumedPseudoParameter' | 'assumedCandidateStackName';
};

/**
 * Resolves one `Fn::ImportValue` call's raw export-name expression against
 * the export symbol table, trying three strategies in order — each a
 * strictly weaker assumption than the last, and each labeled distinctly on
 * a successful match via `matchedVia` (never silently treated as equally
 * certain):
 *
 * 1. **Exact.** Resolve normally (Sprint 1 behavior, parameter `Default`s
 *    used as-is). Matches whenever the import doesn't depend on any
 *    unresolved pseudo parameter or a parameter whose `Default` happens to
 *    already agree with the exporting template's assumed name.
 * 2. **Assumed pseudo parameter (PO Question 4b).** Only tried if the
 *    exact resolution actually depended on an `AWS::*` pseudo parameter —
 *    re-resolve with this template's own assumed pseudo-parameter values
 *    substituted (symmetric with how `graph/exports.ts` resolves the
 *    export side).
 * 3. **Assumed candidate stack name (PO Question 4f).** Real fixtures
 *    (`examples/03-multi-stack-ecs-fargate`) showed some templates name the
 *    exporting stack via a regular `Parameter` (not `AWS::StackName`)
 *    whose own `Default` is just a placeholder. Retry once per *other*
 *    template being merged, forcing every `Parameters` reference in the
 *    expression to that template's own `assumedStackName()`. Accepted only
 *    if exactly one candidate template's substitution produces a match —
 *    zero or 2+ distinct matches stays ambiguous, never guessed.
 */
function resolveImportCall(
  argNode: AstNode,
  plainContext: ResolutionContext,
  assumedContext: ResolutionContext,
  siblingStackNames: string[],
  symbolTable: ExportSymbolTable,
): { resolution: ImportResolution } | { failureReason: string } {
  const plainResolved = resolveValue(argNode, plainContext);
  const plainKey = collapseToMatchKey(plainResolved);
  if (plainKey !== undefined) {
    const entry = symbolTable.byName.get(plainKey);
    if (entry !== undefined) {
      return { resolution: { matchKey: plainKey, entry, matchedVia: 'exact' } };
    }
  }

  if (containsPseudoParameterRef(plainResolved)) {
    const assumedResolved = resolveValue(argNode, assumedContext);
    const assumedKey = collapseToMatchKey(assumedResolved);
    if (assumedKey !== undefined) {
      const entry = symbolTable.byName.get(assumedKey);
      if (entry !== undefined) {
        return { resolution: { matchKey: assumedKey, entry, matchedVia: 'assumedPseudoParameter' } };
      }
    }
  }

  const candidateMatches = new Map<string, ExportTableEntry>();
  for (const candidateStackName of siblingStackNames) {
    const candidateContext = buildCandidateContext(plainContext, candidateStackName);
    const candidateKey = collapseToMatchKey(resolveValue(argNode, candidateContext));
    if (candidateKey === undefined) continue;
    const entry = symbolTable.byName.get(candidateKey);
    if (entry !== undefined) {
      candidateMatches.set(`${entry.file}#${entry.outputName}`, entry);
    }
  }
  if (candidateMatches.size === 1) {
    const entry = [...candidateMatches.values()][0]!;
    return { resolution: { matchKey: entry.matchKey, entry, matchedVia: 'assumedCandidateStackName' } };
  }
  if (candidateMatches.size > 1) {
    return { failureReason: 'Fn::ImportValue matched more than one export under different assumed stack-name candidates — ambiguous' };
  }

  if (plainKey === undefined) {
    return { failureReason: `Fn::ImportValue export name ${describeUnresolvableReason(plainResolved)}` };
  }
  const isConflict = symbolTable.warnings.some((w) => w.kind === 'duplicateExportName' && w.matchKey === plainKey);
  return {
    failureReason: isConflict
      ? `Fn::ImportValue references export "${plainKey}", which is ambiguous (declared by more than one template)`
      : `Fn::ImportValue references export "${plainKey}", which is not exported by any provided template`,
  };
}

/**
 * Merges N already-parsed templates into one {@link GraphModel} (Ticket
 * 2.3): every template's own `buildGraph()` result (Ticket 2.1) combined,
 * plus `crossStackImport` edges resolved against the export symbol table
 * (Ticket 2.2) for every `Fn::ImportValue` call found. Per PO Question 4,
 * an import that can't be matched to any export is flagged via a
 * `GraphWarning` — the run still succeeds with a partial graph, never
 * fails outright.
 */
export function mergeGraphs(templates: LoadedTemplate[]): GraphModel {
  const perTemplateGraphs = templates.map(({ file, ast }) => buildGraph(file, ast));
  const symbolTable = buildExportSymbolTable(templates);

  const nodes = perTemplateGraphs.flatMap((g) => g.nodes);
  const edges: GraphEdge[] = perTemplateGraphs.flatMap((g) => g.edges);
  const warnings: GraphWarning[] = perTemplateGraphs.flatMap((g) => g.warnings);

  const stackNameByFile = new Map(templates.map(({ file }) => [file, assumedStackName(file)]));

  for (const { file, ast: template } of templates) {
    const baseContext = buildResolutionContext(template);
    const conditionResults = evaluateConditions(template, baseContext);
    const plainContext: ResolutionContext = { ...baseContext, conditions: conditionResults };
    const assumedContext: ResolutionContext = { ...plainContext, assumedPseudoParameters: buildAssumedPseudoParameters(file) };
    const siblingStackNames = templates.filter((t) => t.file !== file).map((t) => stackNameByFile.get(t.file)!);

    const resourcesNode = findEntry(template, 'Resources');
    if (resourcesNode?.kind !== 'object') continue;

    for (const { key: logicalId, value: resourceNode } of resourcesNode.entries) {
      const propertiesNode = findEntry(resourceNode, 'Properties');
      if (propertiesNode === undefined) continue;

      for (const { path, argNode } of findImportValueCalls(propertiesNode, [])) {
        const result = resolveImportCall(argNode, plainContext, assumedContext, siblingStackNames, symbolTable);
        if ('failureReason' in result) {
          warnings.push({ kind: 'unresolvedImport', file, logicalId, message: result.failureReason });
          continue;
        }

        const { entry, matchKey, matchedVia } = result.resolution;
        const source = nodeId(file, logicalId);
        walkResolvedValueLeaves(entry.value, [], (_leafPath, leaf) => {
          if (leaf.kind === 'resourceRef') {
            edges.push({
              kind: 'crossStackImport',
              source,
              target: nodeId(entry.file, leaf.logicalId),
              propertyPath: path,
              via: { kind: 'ref' },
              exportName: matchKey,
              matchedVia,
            });
          } else if (leaf.kind === 'attributeRef') {
            edges.push({
              kind: 'crossStackImport',
              source,
              target: nodeId(entry.file, leaf.logicalId),
              propertyPath: path,
              via: { kind: 'getAtt', attribute: leaf.attribute },
              exportName: matchKey,
              matchedVia,
            });
          }
          // Any other leaf kind (e.g. a plain literal Value): the export
          // name matched, but the exported Value isn't itself a reference
          // to a specific resource, so there's no target to draw an edge
          // to — not a warning, mirroring how a literal property value
          // produces no `reference` edge either.
        });
      }
    }
  }

  return { nodes, edges, warnings };
}
