/**
 * Shared between `render/build.ts` (Node-side, main `tsconfig.json`) and
 * `render/browser/app.ts` (browser-side, `tsconfig.browser.json`'s DOM
 * lib) — deliberately its own file with no DOM dependency, so both sides
 * can import the same type definitions without pulling `app.ts` (and its
 * DOM usage) into the main Node program via a transitive import.
 * `tsconfig.json`'s `exclude` only keeps `browser/` out of *root* file
 * discovery; it does not stop a same-program import from reaching in, so
 * this split is what actually prevents that.
 *
 * `RenderNode`/`RenderEdge`/`RenderGraph` are a deliberately thin
 * projection of Sprint 2's `GraphNode`/`GraphEdge` — the renderer only
 * ever needs an id, a label, and (optionally, for future styling) a
 * resource type, not the full resolved-properties/inclusion/position
 * payload. Wiring a real `GraphModel` into this shape is Ticket 3.4's job;
 * Ticket 3.2 (this module) works against the shape directly so the
 * renderer's own contract doesn't change when that wiring lands.
 */
export interface RenderNode {
  id: string;
  label: string;
  type?: string;
}

export interface RenderEdge {
  source: string;
  target: string;
}

export interface RenderGraph {
  nodes: RenderNode[];
  edges: RenderEdge[];
}
