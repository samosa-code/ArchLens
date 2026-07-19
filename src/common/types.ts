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
