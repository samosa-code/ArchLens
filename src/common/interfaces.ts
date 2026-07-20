import type { AstNode, ConditionValue } from './types.js';

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
