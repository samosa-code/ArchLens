import type { AstNode } from '../../common/types.js';

/** Returns the entry value for `key` on an object-kind node, throwing if it's missing. */
export function getEntry(node: AstNode, key: string): AstNode {
  if (node.kind !== 'object') throw new Error(`expected object node looking for key "${key}"`);
  const entry = node.entries.find((e) => e.key === key);
  if (!entry) throw new Error(`missing key "${key}"`);
  return entry.value;
}

/** Walks a chain of object keys, e.g. `getPath(ast, 'Resources', 'MyBucket', 'Properties')`. */
export function getPath(node: AstNode, ...keys: string[]): AstNode {
  return keys.reduce(getEntry, node);
}
