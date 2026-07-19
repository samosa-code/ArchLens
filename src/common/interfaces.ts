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
