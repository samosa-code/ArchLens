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
