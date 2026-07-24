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
 * projection — the renderer never imports `GraphModel` or
 * `ArchitectureGraph` directly (see ADR 0005's real-gotcha and the Sprint
 * 3.5 architecture-review confirmation that this boundary held). Two
 * producers feed this same shape: `fromGraphModelRaw.ts` (Sprint 2's 1:1
 * view — populates only `id`/`label`/`type`) and `fromArchitectureGraph.ts`
 * (Ticket 3.3 — populates everything below, for the detail panel and
 * edge/container styling). Every field beyond `id`/`label` is optional for
 * exactly this reason: the raw projection has nothing to put there, and
 * the renderer must degrade gracefully (a plainer panel, no container
 * nesting) rather than assume a richer producer.
 */
export interface RenderAbsorbedResource {
  nodeId: string;
  logicalId: string;
  resourceType: string;
  file: string;
  line: number;
  group: 'permissions' | 'networking' | 'observability' | 'lifecycle' | 'plumbing';
  reason: string;
  /** True if a badge on the owning node names this specific absorbed resource — per-item warning tint (PO Question 24), never "every item is a finding". */
  hasFinding: boolean;
}

export interface RenderBadge {
  kind: 'security' | 'cost';
  message: string;
  /** The node/absorbed-resource id that triggered this finding — what `hasFinding` matches against. */
  sourceNodeId: string;
}

export interface RenderNode {
  id: string;
  label: string;
  /** The owner resource's original CloudFormation type. */
  type?: string;
  /** Normalized service name (`'lambda'`, `'dynamodb'`, ...) — an icon *key*, not an icon (real icon graphics are Sprint 13's job; today this drives a text subtitle and a `data-service` hook for future CSS). */
  service?: string;
  /** Which horizontal band it renders in — `undefined` only for the raw 1:1 projection, which has no layer concept. */
  layer?: string;
  /** The `RenderContainer` it sits inside, if any — the nesting hint. */
  containerId?: string;
  /** Absolute path of the template file it was declared in — powers the detail panel's file:line. */
  file?: string;
  /** 1-based line of its declaration. */
  line?: number;
  /** Everything folded into this component — the detail panel's grouped sections. Absent (not empty) when the producer has no absorption concept (the raw projection). */
  absorbed?: RenderAbsorbedResource[];
  /** Security/cost findings on this node itself (not on an absorbed resource — those are matched via `hasFinding`). */
  badges?: RenderBadge[];
  /** Why the generator kept this as its own box — `AbstractionDecision.reason`, shown in the panel header. */
  decisionReason?: string;
}

export interface RenderEdge {
  source: string;
  target: string;
  /** What kind of relationship this is — drives line style (solid/dashed) and is never `'containment'` (nesting is expressed via `containerId`/`RenderContainer.parentId`, not an edge). */
  kind?: 'invocation' | 'dataAccess' | 'network' | 'association';
  /** Short verb label rendered on the edge and in the Connections panel section — `'invokes'`, `'reads/writes'`, ... */
  label?: string;
  /** Sync (solid) vs. async (dashed) rendering. */
  delivery?: 'sync' | 'async';
  /** True if the drawn direction was flipped from the template's by layer ordering — surfaced in the Connections section, never silent. */
  inferred?: boolean;
}

/** A boundary drawn *around* nodes (VPC, Subnet, cluster, stack, account, region) — rendered as a labeled background region, never as a box with edges. */
export interface RenderContainer {
  id: string;
  label: string;
  kind: 'vpc' | 'subnet' | 'cluster' | 'stack' | 'account' | 'region';
  /** The container this one nests inside, if any. */
  parentId?: string;
}

export interface RenderGraph {
  nodes: RenderNode[];
  edges: RenderEdge[];
  /** Absent (not empty) for the raw 1:1 projection, which has no container concept. */
  containers?: RenderContainer[];
}
