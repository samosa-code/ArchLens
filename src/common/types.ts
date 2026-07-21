import type { AstEntry, SourcePosition } from './interfaces.js';

/**
 * A normalized, format-agnostic node in a parsed template's syntax tree.
 *
 * Both YAML and JSON templates are parsed down to this same shape (see
 * `parser/loader.ts`), so downstream code never needs to know which source
 * format a template was written in.
 */
export type AstNode =
  | { kind: 'object'; entries: AstEntry[]; pos: SourcePosition }
  | { kind: 'array'; items: AstNode[]; pos: SourcePosition }
  | { kind: 'scalar'; value: string | number | boolean | null; pos: SourcePosition };

/**
 * The result of resolving a property value (from an {@link AstNode}) against
 * a template's `Parameters`/`Resources`/`Mappings`, produced by
 * `parser/intrinsics.ts`.
 *
 * `object` and `list` mirror non-intrinsic structure from the source AST
 * (position metadata dropped, since a resolved value may combine pieces
 * from several source locations). `resourceRef`/`attributeRef`/
 * `parameterRef`/`pseudoParameterRef` are deploy-time-unknown by nature —
 * resolving further would mean guessing, which we don't do. `unresolved`
 * covers anything genuinely undeterminable (undefined name, dynamic index,
 * malformed arguments) and always carries a human-readable reason.
 */
export type ResolvedValue =
  | { kind: 'scalar'; value: string | number | boolean | null }
  | { kind: 'list'; items: ResolvedValue[] }
  | { kind: 'object'; entries: { key: string; value: ResolvedValue }[] }
  /** `Ref` to a declared `Resources` entry — the "reference edge" the graph model builds on. */
  | { kind: 'resourceRef'; logicalId: string }
  /** `Fn::GetAtt`, from either its array form or its dotted-string form. */
  | { kind: 'attributeRef'; logicalId: string; attribute: string }
  /** `Ref` to a declared `Parameters` entry with no statically-known `Default`. */
  | { kind: 'parameterRef'; name: string }
  /** `Ref` to an `AWS::*` pseudo parameter (e.g. `AWS::Region`) — always deploy-time-unknown. */
  | { kind: 'pseudoParameterRef'; name: string }
  /**
   * `Fn::ImportValue`, tagged but not resolved — resolving it means matching
   * `exportName` against another template's `Outputs.*.Export.Name`, which
   * requires the multi-stack merge Sprint 2 builds. `exportName` is itself
   * fully resolved here (e.g. a `Fn::Join` collapsed to a literal string),
   * so Sprint 2 can match it directly without re-walking the AST.
   */
  | { kind: 'importValueRef'; exportName: ResolvedValue }
  /**
   * `Fn::GetAZs` — the list of Availability Zone names for `region`
   * (itself a `ResolvedValue`, e.g. a `pseudoParameterRef` for the common
   * `!GetAZs {Ref: AWS::Region}`/bare `!GetAZs ""` "current region" form).
   * Always deploy-time- and account-specific (which AZs are enabled/opted
   * into differs per account, even within the same region) — never
   * guessed at a literal list, the same stance as `pseudoParameterRef`.
   */
  | { kind: 'availabilityZonesRef'; region: ResolvedValue }
  /**
   * `Fn::Select`'s result when selecting a static index out of an
   * `availabilityZonesRef` (an extremely common real-world idiom, `!Select
   * [N, !GetAZs '']`, for pinning a resource to "the Nth AZ" without
   * knowing its actual name) — distinct from the general `unresolved`
   * case specifically because the *position* is known even though the
   * actual AZ name isn't, which is useful information to preserve rather
   * than collapsing to an undifferentiated "couldn't resolve."
   */
  | { kind: 'availabilityZoneRef'; region: ResolvedValue; index: number }
  | { kind: 'unresolved'; reason: string };

/**
 * The three-valued (true/false/unknown) result of evaluating one named
 * `Conditions` block entry, produced by `parser/conditions.ts`.
 *
 * Deliberately not a plain boolean: a condition that depends on a parameter
 * with no `Default` (or any other deploy-time-only value) is genuinely
 * undeterminable from the template alone, and per this project's
 * graceful-degradation stance (PO Question 1), that must stay visibly
 * `unknown` rather than being guessed as `true` or `false`.
 */
export type ConditionValue = { kind: 'true' } | { kind: 'false' } | { kind: 'unknown'; reason: string };

/**
 * Whether a resource is actually created, given its (optional) `Condition`
 * attribute and the evaluated `Conditions` block. A resource with no
 * `Condition` attribute is always `included`. `unknown` is PO Question 1's
 * "distinct unknown/conditional" outcome — the resource's condition
 * couldn't be statically resolved, so it must be flagged, never silently
 * included or omitted.
 */
export type ResourceInclusion = { kind: 'included' } | { kind: 'excluded' } | { kind: 'unknown'; reason: string };

/**
 * A {@link GraphNode}'s identity: `${file}#${logicalId}`, never just the
 * logical ID alone. Per PO Question 4d, two unrelated templates that happen
 * to declare a same-named resource must never collapse into one graph node
 * — see `graph/model.ts`'s `nodeId()` for the exact formula.
 */
export type GraphNodeId = string;

/**
 * A problem `graph/exports.ts`'s `buildExportSymbolTable()` found while
 * indexing `Outputs`/`Export` values across templates, produced instead of
 * (never in addition to, never silently instead of nothing) a usable table
 * entry for that export.
 */
export type ExportTableWarning =
  | {
      /**
       * Per PO Question 4c: two or more templates' exports resolve to the
       * exact same (possibly-assumed) name. Neither is used for cross-stack
       * matching — never last-wins.
       */
      kind: 'duplicateExportName';
      matchKey: string;
      occurrences: { file: string; outputName: string }[];
    }
  | {
      /**
       * The export's `Export.Name` expression didn't collapse to one
       * literal string even after substituting assumed pseudo-parameter
       * values — most commonly a plain `Parameters` entry with no
       * `Default` (e.g. `01-simple-lambda`'s `${EnvName}`), which PO
       * Question 2's "never guess" precedent already covers unchanged.
       */
      kind: 'unresolvableExportName';
      file: string;
      outputName: string;
      reason: string;
    };

/**
 * A directed edge in the {@link GraphModel}, produced by `graph/model.ts`'s
 * `buildGraph()`. Discriminated by `kind` so each variant only carries the
 * fields that make sense for it — deliberately extensible: later sprints add
 * `network`/`iam` edge kinds without reworking `reference`/`dependsOn`.
 *
 * Per the resolved design fork (Sprint 2 kickoff), edges are never
 * collapsed: the same source/target pair referenced twice in a resource's
 * `Properties` produces two distinct `reference` edges, one per occurrence,
 * each with its own `propertyPath` — collapsing them would hide that the
 * template author wrote two references, which may matter later (e.g. one
 * inside a conditional branch and one not).
 */
export type GraphEdge =
  | {
      kind: 'reference';
      source: GraphNodeId;
      target: GraphNodeId;
      /**
       * Where inside the source resource's `Properties` this reference
       * occurred, relative to `Properties` itself (e.g.
       * `['VPCZoneIdentifier', '0']` for the first item of that list
       * property) — not prefixed with `'Properties'`, since `reference`
       * edges (at least as of Ticket 2.1) only ever originate there.
       */
      propertyPath: string[];
      /** Whether this reference is a whole-resource `Ref` or a `Fn::GetAtt` to one specific attribute. */
      via: { kind: 'ref' } | { kind: 'getAtt'; attribute: string };
    }
  | {
      /**
       * From a resource's `DependsOn` attribute — a distinct kind from
       * `reference` because `DependsOn` bypasses `resolveValue()` entirely
       * (it's a bare logical-ID string/list, never an intrinsic), so its
       * target existence has to be validated separately (see
       * `graph/model.ts`) and it carries no `propertyPath`, being a
       * resource-attribute, not a `Properties` value.
       */
      kind: 'dependsOn';
      source: GraphNodeId;
      target: GraphNodeId;
    }
  | {
      /**
       * A resolved cross-stack `Fn::ImportValue` → `Export` match, produced
       * by `graph/merge.ts`'s `mergeGraphs()` (Ticket 2.3) — not by Ticket
       * 2.1's single-template `buildGraph()`. `target` is a resource inside
       * the *exporting* template, found by walking that `Export`'s `Value`
       * for a `resourceRef`/`attributeRef` leaf the same way `reference`
       * edges are found (an exported `Value` that's a plain literal, with
       * no such leaf, produces no edge at all — nothing to point at).
       */
      kind: 'crossStackImport';
      source: GraphNodeId;
      target: GraphNodeId;
      /** Where inside the source resource's `Properties` the `Fn::ImportValue` call occurred — same convention as `reference`'s `propertyPath`. */
      propertyPath: string[];
      /** Whether the export's `Value` pointed at the target via a whole-resource `Ref` or a `Fn::GetAtt` to one attribute — mirrors `reference`'s `via`. */
      via: { kind: 'ref' } | { kind: 'getAtt'; attribute: string };
      /** The literal export name both sides matched on. */
      exportName: string;
      /**
       * How confident this match is, always surfaced — never silently
       * treated as equally certain as an exact match:
       * - `'exact'`: the import's export-name expression, resolved with
       *   Sprint 1's ordinary (never-guess) behavior, already matched a
       *   real export.
       * - `'assumedPseudoParameter'`: needed PO Question 4b's assumed
       *   `AWS::*` pseudo-parameter substitution on the import side too
       *   (e.g. the import itself uses `AWS::StackName`).
       * - `'assumedCandidateStackName'`: PO Question 4f — the import used a
       *   regular `Parameter` (not a pseudo parameter) to name the
       *   exporting stack, whose own `Default` didn't match anything;
       *   resolved only by retrying with each sibling template's own
       *   assumed stack name substituted in, and finding exactly one that
       *   uniquely matched. The weakest, most-assumed case.
       */
      matchedVia: 'exact' | 'assumedPseudoParameter' | 'assumedCandidateStackName';
    };

/**
 * A structural problem `graph/model.ts`'s `buildGraph()` or
 * `graph/merge.ts`'s `mergeGraphs()` couldn't resolve into a valid edge.
 * Per this project's "never silently drop" stance, always surfaced here
 * rather than the offending attribute/reference just being skipped quietly.
 */
export type GraphWarning =
  | {
      /**
       * A `DependsOn` entry naming a logical ID that isn't declared in the
       * same template, or a `DependsOn` value that isn't a string or array
       * of strings. `DependsOn` bypasses `resolveValue()`, so it can't
       * reuse `Ref`/`Fn::GetAtt`'s "unresolved" path — see `graph/model.ts`.
       */
      kind: 'dependsOnTargetInvalid';
      file: string;
      logicalId: string;
      message: string;
    }
  | {
      /**
       * An `Fn::ImportValue` that couldn't be matched to any export across
       * every provided template — either its export-name expression never
       * collapsed to a literal (even after PO Question 4b/4f's assumption
       * attempts), no template exports that name, or it matched a name
       * flagged as an ambiguous `duplicateExportName` conflict (PO Question
       * 4c) or matched two *different* exports under PO 4f's candidate
       * search (also ambiguous). Per PO Question 4, the run still succeeds
       * with a partial graph — this warning is the "flagged, not silently
       * dropped" half of that decision; a visible node/badge is a
       * rendering-layer concern for later sprints to build on top of this.
       */
      kind: 'unresolvedImport';
      file: string;
      logicalId: string;
      message: string;
    };
