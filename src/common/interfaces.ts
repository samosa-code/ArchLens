import type { AstNode, ConditionValue, ExportTableWarning, GraphEdge, GraphNodeId, GraphWarning, ResolvedValue, ResourceInclusion } from './types.js';

/**
 * A single point in an original template source file, used for click-to-source
 * navigation and for pointing the user at the exact line a resource/property
 * came from.
 */
export interface SourcePosition {
  /** Absolute path to the source template file. */
  file: string;
  /** 1-indexed line number within {@link SourcePosition.file}. */
  line: number;
  /** 1-indexed column number within the line. */
  column: number;
}

/**
 * One key/value pair inside an object-kind {@link AstNode}, e.g. one
 * `Resources.<LogicalId>` entry.
 */
export interface AstEntry {
  /** The object key, as written in the source (YAML/JSON key). */
  key: string;
  /** Source position of the key itself, not its value. */
  keyPos: SourcePosition;
  /** The parsed value for this key. */
  value: AstNode;
}

/**
 * Everything `parser/intrinsics.ts` needs from a template to resolve its
 * supported intrinsic functions — built once per template via
 * `buildResolutionContext()` and passed to every `resolveValue()` call.
 */
export interface ResolutionContext {
  /** Parameter name -> its `Default` AstNode, or `undefined` if it has none. */
  parameters: Map<string, AstNode | undefined>;
  /** Logical IDs of every declared `Resources` entry, for `Ref`/`Fn::GetAtt` existence checks. */
  resources: Set<string>;
  /** Mapping name -> its definition AstNode, consumed by `Fn::FindInMap`. */
  mappings: Map<string, AstNode>;
  /**
   * Named `Conditions` block entry -> its evaluated {@link ConditionValue},
   * consumed by `Fn::If`. Empty by default from `buildResolutionContext()` —
   * callers that need `Fn::If` to actually resolve must separately run
   * `parser/conditions.ts`'s `evaluateConditions()` and merge the result in,
   * since evaluating conditions itself needs `resolveValue()` (for
   * `Fn::Equals` operands), and this module can't import that one without a
   * circular dependency.
   */
  conditions: Map<string, ConditionValue>;
  /**
   * `AWS::*` pseudo-parameter name -> an assumed literal value to substitute
   * in its place, e.g. `"AWS::StackName" -> "network-stack"`. Absent (the
   * default) preserves Sprint 1's behavior exactly — every `Ref` to an
   * `AWS::*` name resolves to `pseudoParameterRef`, never guessed.
   *
   * Only ever set by `graph/exports.ts` when resolving `Export.Name`
   * expressions for the cross-stack symbol table (PO Question 4b) — a
   * template file has no real deploy-time pseudo-parameter values, but
   * needs *some* stable, consistent value to compare export names across
   * sibling templates. Never used for resolving ordinary `Properties`
   * values, where guessing a pseudo parameter would misrepresent the
   * template's actual (unknown) runtime behavior.
   */
  assumedPseudoParameters?: Map<string, string>;
}

/** One successfully-loaded template, from `parser/loader.ts`'s `loadTemplates()`. */
export interface LoadedTemplate {
  /** Absolute path of the source file. */
  file: string;
  /** Its parsed AST. */
  ast: AstNode;
}

/**
 * One file `loadTemplates()` couldn't load, paired with the human-readable
 * reason (the underlying `loadTemplate()` error message) — per PO Question 3
 * (skip-and-warn), this is surfaced, not silently dropped.
 */
export interface TemplateLoadWarning {
  /** Absolute path of the file that failed to load. */
  file: string;
  /** Why it failed — the underlying parse error's message. */
  message: string;
}

/** The result of `loadTemplates()`: whatever loaded successfully, plus a warning per file that didn't. */
export interface LoadTemplatesResult {
  templates: LoadedTemplate[];
  warnings: TemplateLoadWarning[];
}

/**
 * One resource, as a node in the {@link GraphModel} built by
 * `graph/model.ts`'s `buildGraph()`.
 */
export interface GraphNode {
  /** `${file}#${logicalId}` — see {@link GraphNodeId}. Never just `logicalId`, per PO Question 4d. */
  id: GraphNodeId;
  /** The resource's logical ID, as declared in `Resources`. */
  logicalId: string;
  /** The resource's `Type`, if it's a literal string (it always should be) — `undefined` otherwise. */
  type: string | undefined;
  /** Absolute path of the template file this resource was declared in — doubles as its origin stack until nested-stack modeling exists. */
  file: string;
  /** Source position of the resource's own declaration (its `Resources.<LogicalId>` entry), for click-to-source navigation. */
  pos: SourcePosition;
  /** The resource's `Properties` block, fully resolved — `undefined` if it has none. */
  properties: ResolvedValue | undefined;
  /** Whether this resource is actually created, per its (optional) `Condition` attribute. Per PO Question 1, never omitted — always a node, even when `excluded` or `unknown`. */
  inclusion: ResourceInclusion;
}

/**
 * The unified resource graph — one or more templates' worth of
 * {@link GraphNode}s and the {@link GraphEdge}s between them, plus any
 * {@link GraphWarning}s raised while building it.
 */
export interface GraphModel {
  nodes: GraphNode[];
  edges: GraphEdge[];
  warnings: GraphWarning[];
}

/**
 * One successfully-indexed `Outputs.*` entry that has both an `Export.Name`
 * and a `matchKey` — its (possibly pseudo-parameter-assumed) export name,
 * collapsed to a single literal string. Entries whose export name never
 * collapses to a literal (see {@link ExportTableWarning}'s
 * `unresolvableExportName`) never produce one of these.
 */
export interface ExportTableEntry {
  /** Absolute path of the template file this export was declared in. */
  file: string;
  /** The `Outputs.<Name>` key this export came from. */
  outputName: string;
  /** The fully-resolved, literal export name used for cross-stack matching. */
  matchKey: string;
  /** Whether producing `matchKey` required substituting an assumed pseudo-parameter value (PO Question 4b) — always surfaced, never silently treated as deployed truth. */
  usedAssumedPseudoParameters: boolean;
  /** The Output's `Value`, fully resolved (may itself be `unresolved`/a reference — this field doesn't gate whether the entry is indexable, only `matchKey` does). */
  value: ResolvedValue;
  /** Whether this Output actually exists, per its own (optional) `Condition` attribute — reuses `ResourceInclusion`'s shape/semantics unchanged (PO Question 1). `excluded` outputs are never given an entry at all. */
  inclusion: ResourceInclusion;
}

/**
 * The cross-stack export lookup table built by `graph/exports.ts`'s
 * `buildExportSymbolTable()` from N parsed templates (Ticket 2.2).
 */
export interface ExportSymbolTable {
  /**
   * `matchKey` -> its one unambiguous {@link ExportTableEntry}. A name
   * claimed by more than one entry is deliberately absent here — see
   * `warnings` for a `duplicateExportName` entry instead (PO Question 4c:
   * never last-wins).
   */
  byName: Map<string, ExportTableEntry>;
  warnings: ExportTableWarning[];
}
