import type { AstNode } from './types.js';

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
 * Everything `parser/intrinsics.ts` needs from a template to resolve `Ref`,
 * `Fn::GetAtt`, `Fn::Join`, and `Fn::Select` — built once per template via
 * `buildResolutionContext()` and passed to every `resolveValue()` call.
 */
export interface ResolutionContext {
  /** Parameter name -> its `Default` AstNode, or `undefined` if it has none. */
  parameters: Map<string, AstNode | undefined>;
  /** Logical IDs of every declared `Resources` entry, for `Ref`/`Fn::GetAtt` existence checks. */
  resources: Set<string>;
  /**
   * Mapping name -> its definition AstNode. Not consumed by `Ref`/`GetAtt`/
   * `Join`/`Select` themselves — stored here so `Fn::FindInMap` (Ticket 1.3)
   * can reuse the same context without a second AST walk.
   */
  mappings: Map<string, AstNode>;
}
