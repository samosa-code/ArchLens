import type { ResolvedValue } from '../common/types.js';

/**
 * Recursively walks a resolved value tree, invoking `visit` at every leaf —
 * anything that isn't a `list`/`object` structural node — with the path
 * from the root. Shared by `graph/model.ts` (finding `resourceRef`/
 * `attributeRef` leaves for `reference` edges) and `graph/merge.ts` (finding
 * `importValueRef` leaves for cross-stack matching, and walking an export's
 * `Value` to find its target resource).
 *
 * Deliberately does NOT special-case any particular leaf kind — in
 * particular, `importValueRef` is a leaf like any other, never recursed
 * into its own `exportName`. That's what makes a `Ref` nested inside an
 * `Fn::ImportValue` export-name expression correctly stay invisible to
 * `reference`-edge extraction (see ADR 0002) without this shared walker
 * needing to know that rule itself — callers that care about
 * `resourceRef`/`attributeRef` simply never encounter one buried inside an
 * `importValueRef`, because this walker doesn't go looking there.
 */
export function walkResolvedValueLeaves(value: ResolvedValue, path: string[], visit: (path: string[], leaf: ResolvedValue) => void): void {
  if (value.kind === 'list') {
    value.items.forEach((item, index) => walkResolvedValueLeaves(item, [...path, String(index)], visit));
    return;
  }
  if (value.kind === 'object') {
    value.entries.forEach(({ key, value: entryValue }) => walkResolvedValueLeaves(entryValue, [...path, key], visit));
    return;
  }
  visit(path, value);
}
