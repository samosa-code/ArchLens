/**
 * Types for the Architecture Generator (Sprint 3.5) — the abstraction stage
 * that consumes the complete, nothing-discarded {@link GraphModel} and
 * produces a reduced, reinterpreted `ArchitectureGraph`: a logical
 * architecture diagram in the style of AWS's reference diagrams, not an
 * infrastructure dependency graph.
 *
 * Shapes follow `internal-docs/ARCHITECTURE-GENERATOR-SPEC.md` §4, corrected
 * against this codebase's real types where the spec explicitly marked its
 * own assumptions as unverified: edges use `source`/`target` (matching
 * {@link GraphEdge}), not the spec's assumed `from`/`to`, and node ids are
 * the real `${file}#${logicalId}` {@link GraphNodeId} format.
 *
 * Deliberately DOM-free and dependency-free (types only): consumed by both
 * the Node-side generator pipeline and, later, the browser-side renderer,
 * the same dual-tsconfig constraint `render/types.ts` already satisfies
 * (see ADR 0005 on why `exclude` alone doesn't prevent transitive imports).
 */
import type { GraphNodeId } from '../common/types.js';

/**
 * The horizontal band an {@link ArchNode} renders in. Layers are
 * rule-assigned (never topology-derived — see spec §6: topological ordering
 * is undefined on cyclic references), ordered top-to-bottom as
 * `edge(0) → presentation(1) → auth(2) → api(3) → compute(4) →
 * integration(5) → data(6)`. `monitoring`, `network`, and `unassigned` sit
 * outside that ordering.
 *
 * Per PO Question 17, `monitoring` is always visible by default (the spec's
 * own hide-by-default suggestion was overridden) — hidden only by the
 * explicit `--hide-monitoring` opt-out.
 */
export type ArchLayer =
  | 'edge'
  | 'presentation'
  | 'auth'
  | 'api'
  | 'compute'
  | 'integration'
  | 'data'
  | 'monitoring'
  | 'network'
  | 'unassigned';

/**
 * What kind of relationship an {@link ArchEdge} expresses. `containment` is
 * never drawn as an arrow — it becomes visual nesting inside an
 * {@link ArchContainer}.
 */
export type ArchEdgeKind = 'invocation' | 'dataAccess' | 'network' | 'containment' | 'association';

/**
 * Whether the interaction an {@link ArchEdge} represents is a direct
 * synchronous call or an async/event-driven hand-off (SQS, SNS,
 * EventBridge, S3 notifications, event source mappings). Per PO Question
 * 23, the renderer maps this to solid (sync) vs. dashed (async) edge
 * styling — connector rules declare it at extraction time (Ticket A.6).
 */
export type EdgeDelivery = 'sync' | 'async';

/**
 * Which collapsible section of the detail panel an {@link AbsorbedResource}
 * appears under (spec §9) — the panel's content model, not a rendering
 * concern.
 */
export type AbsorbedGroup = 'permissions' | 'networking' | 'observability' | 'lifecycle' | 'plumbing';

/**
 * The audit-log record for one {@link GraphModel} node (spec §3): what the
 * generator did with it, under which rule/heuristic, and why. The
 * accounting invariant — every source node appears in
 * {@link ArchitectureGraph.decisions} exactly once — is what keeps the
 * generator consistent with this project's "never silently discard" posture
 * even though its whole job is hiding things.
 */
export interface AbstractionDecision {
  /** The {@link GraphModel} node this decision is about. */
  nodeId: GraphNodeId;
  /** What happened to it: kept visible, absorbed into an owner, converted to an edge, promoted to a container boundary, kept visible because nothing matched (`kept-unknown`), or — for a node with no source at all — `synthetic` (Ticket A.9's Internet/Users node). */
  action: 'kept' | 'absorbed' | 'converted-to-edge' | 'promoted-to-container' | 'kept-unknown' | 'synthetic';
  /** Which rule or heuristic decided — e.g. `"rule:AWS::IAM::Role"` or `"heuristic:single-neighbour-suffix-match"`. */
  rule: string;
  /** Human-readable explanation, shown by `--explain` and the UI's "why is this not on the diagram?". */
  reason: string;
  /** How the decision was reached: an explicit rule-table match, the structural heuristic, or the kept-unknown fallback. */
  confidence: 'rule' | 'heuristic' | 'fallback';
  /** For `absorbed`/`converted-to-edge`: the surviving {@link ArchNode}/{@link ArchContainer} id it was folded into. */
  absorbedInto?: GraphNodeId;
}

/**
 * One hidden resource folded into an {@link ArchNode} or
 * {@link ArchContainer} — powers the detail panel's grouped sections and
 * keeps click-to-source (Sprint 4) working for resources that are no longer
 * their own box.
 */
export interface AbsorbedResource {
  /** The original {@link GraphModel} node id. */
  nodeId: GraphNodeId;
  /** The resource's logical ID, for display. */
  logicalId: string;
  /** The resource's original CloudFormation type. */
  resourceType: string;
  /** Absolute path of the template file it was declared in. */
  file: string;
  /** 1-based line of its declaration — click-to-source works for hidden resources too. */
  line: number;
  /** Which detail-panel section it appears under. */
  group: AbsorbedGroup;
  /** Why it was absorbed, mirroring its {@link AbstractionDecision}'s reason. */
  reason: string;
  /** Optional distilled key facts for the panel — e.g. an IAM policy's granted actions/resources. */
  summary?: Record<string, unknown>;
}

/**
 * A security/cost finding attached to an {@link ArchNode} or
 * {@link ArchContainer}. Defined here (rather than in Sprint 9, which
 * populates them) because `sourceNodeId` must exist from day one: a badge
 * triggered by an *absorbed* resource (e.g. a wildcard IAM policy) surfaces
 * on the owning node but must still say which hidden resource caused it —
 * per spec §12, free to include now, expensive to retrofit.
 */
export interface Badge {
  /** What family of finding this is. */
  kind: 'security' | 'cost';
  /** Human-readable finding text. */
  message: string;
  /** The {@link GraphModel} node (possibly an absorbed one) that triggered the finding. */
  sourceNodeId: GraphNodeId;
}

/**
 * A visible box on the architecture diagram — one logical component,
 * usually representing several CloudFormation resources (itself plus
 * everything in {@link ArchNode.absorbed}).
 */
export interface ArchNode {
  /** Stable id — reuses the owning {@link GraphModel} node's id. */
  id: GraphNodeId;
  /** Human-readable display name — never just the raw logical ID when better is derivable. */
  label: string;
  /** Normalized service name (`'lambda'`, `'dynamodb'`, ...) — drives the icon (Sprint 13) and the card subtitle. */
  service: string;
  /** The owner resource's original CloudFormation type. */
  resourceType: string;
  /** Which horizontal band it renders in. */
  layer: ArchLayer;
  /** The {@link ArchContainer} it sits inside (VPC/Subnet/cluster/stack/account), if any. */
  containerId?: string;
  /** The {@link GraphModel} node this component represents. */
  sourceNodeId: GraphNodeId;
  /** Absolute path of the template file it was declared in. Absent only for a synthetic node (Ticket A.9), which has no source file. */
  file?: string;
  /** 1-based line of its declaration — powers the detail panel's "View source" link (Ticket 3.3). Absent only for a synthetic node. */
  line?: number;
  /** Everything folded into this component — powers the detail panel. */
  absorbed: AbsorbedResource[];
  /** This node's own audit-log record. */
  decision: AbstractionDecision;
  /** Security/cost findings, including ones inherited from absorbed resources. */
  badges: Badge[];
  /** True only for a synthetic node (Ticket A.9's Internet/Users) — not present in any template, never to be confused with a real resource. Absent (not `false`) for every real node. */
  inferred?: boolean;
}

/**
 * Where an {@link ArchEdge} came from. Dedupe (Ticket A.7) unions these
 * arrays, never discards — the same provenance-preservation lesson the
 * dagre multigraph bug taught the render layer (see
 * `PROJECT-STATE-2026-07-21.md` §6), applied here by design.
 */
export interface EdgeProvenance {
  /** The original construct kind that produced this edge — a plain graph edge kind, a connector resource, or a synthetic inference (e.g. the Internet/Users node's ingress edge). */
  kind: 'reference' | 'dependsOn' | 'crossStackImport' | 'connector' | 'synthetic';
  /** For `connector`: the hidden resource (e.g. a `Lambda::Permission`) that produced this edge. */
  viaNodeId?: GraphNodeId;
  /** For `connector`: that resource's CloudFormation type. */
  viaResourceType?: string;
  /** Source location of the producing construct, when known. */
  file?: string;
  /** 1-based line of the producing construct, when known. */
  line?: number;
  /** For `reference`/`crossStackImport`: where inside the referencing resource's `Properties` the ref occurred — what distinguishes two references between the same pair (they must union to two provenance entries, not collapse to one). */
  propertyPath?: string[];
}

/**
 * A drawn relationship between two visible {@link ArchNode}s. Uses
 * `source`/`target` to match {@link GraphEdge} (the spec's `from`/`to` was
 * an explicitly-flagged assumption, corrected here).
 */
export interface ArchEdge {
  /** Unique within one {@link ArchitectureGraph}. */
  id: string;
  /** The {@link ArchNode} the relationship points from. */
  source: GraphNodeId;
  /** The {@link ArchNode} the relationship points to. */
  target: GraphNodeId;
  /** What kind of relationship this is. */
  kind: ArchEdgeKind;
  /** Sync (solid) vs. async (dashed) rendering, per PO Question 23. */
  delivery: EdgeDelivery;
  /** Short verb label rendered on the edge — `'invokes'`, `'reads/writes'`, `'publishes to'`. */
  label?: string;
  /** Every original construct that produced this edge — unioned on dedupe, never discarded. */
  derivedFrom: EdgeProvenance[];
  /** Whether an explicit rule or the structural heuristic produced it. */
  confidence: 'rule' | 'heuristic';
  /** True if the drawn direction was flipped from the template's by layer ordering (spec §6) — surfaced, never silent. */
  inferred: boolean;
}

/**
 * A boundary drawn *around* nodes (VPC, Subnet, ECS/EKS cluster, nested
 * stack, account/region) — rendered as a labeled region, never as a box
 * with edges. Per PO Question 20, `account` containers are in scope from
 * the start; `region` was added to the spec §4 union alongside it (a
 * region boundary nests inside its account and is a distinct kind, per PO
 * Question 27's fixture).
 */
export interface ArchContainer {
  /** Stable id — reuses the source {@link GraphModel} node's id where one exists. */
  id: string;
  /** Display label, e.g. `VPC · 10.0.0.0/16`. */
  label: string;
  /** What kind of boundary this is. */
  kind: 'vpc' | 'subnet' | 'cluster' | 'stack' | 'account' | 'region';
  /** The container this one nests inside (Subnet → VPC → account), if any. */
  parentId?: string;
  /** The {@link GraphModel} node it was promoted from — absent for synthetic containers (accounts/regions). */
  sourceNodeId?: GraphNodeId;
  /** Resources folded into the boundary itself — a VPC's route tables, ACLs, gateways. */
  absorbed: AbsorbedResource[];
  /** Security/cost findings on the boundary, including propagated ones (e.g. NAT gateway cost). */
  badges: Badge[];
}

/**
 * The architectural role a resource type plays (spec §1) — the four-way
 * split that drives the whole abstraction:
 * - `component`: a visible box on the diagram.
 * - `container`: a boundary drawn around components, not a box itself.
 * - `detail`: hidden, absorbed into an owner's detail panel.
 * - `connector`: hidden as a node, but *emits edge(s) between components
 *   first*. Load-bearing: most real architectural edges (API Gateway →
 *   Lambda, SQS → Lambda, ALB → ASG) exist in a template ONLY as one of
 *   these resources.
 */
export type Role = 'component' | 'container' | 'detail' | 'connector';

/**
 * Dotted path into a resource's *resolved* `Properties` (post-intrinsics),
 * e.g. `'Integration.Uri'`. Resolution may fail — the connector then
 * degrades to a plain absorbed detail rather than emitting a bad edge
 * (Ticket A.6). Resolved by a dedicated {@link ResolvedValue} walker, not
 * naive object access, since resolved properties are a discriminated union.
 */
export type PropPath = string;

/** Where one end of a connector-emitted edge comes from. */
export type Endpoint =
  /** Resolve an ARN/ref found at `path` in the connector's own properties. */
  | { from: 'prop'; path: PropPath }
  /** The component this connector attaches to (its `absorbInto` owner). */
  | { from: 'owner' }
  /** An AWS service principal at `path` (e.g. a bucket policy's `Principal`), matched to the corresponding component. */
  | { from: 'principal'; path: PropPath }
  /** The synthetic Internet/Users node (Ticket A.9). */
  | { from: 'internet' };

/**
 * How a `connector`-role resource turns into an {@link ArchEdge} before it
 * disappears (Ticket A.6, Pass 4 — always run while the full graph is
 * still intact).
 */
export interface ConnectorSpec {
  /** Where the edge starts. */
  source: Endpoint;
  /** Where the edge points. */
  target: Endpoint;
  /** The emitted edge's relationship kind. */
  kind: ArchEdgeKind;
  /** The emitted edge's rendered label — `'invokes'`, `'routes to'`, ... */
  label: string;
  /**
   * Sync (solid) vs. async (dashed) per PO Question 23, declared statically
   * where the type determines it (`AWS::ApiGateway::Method` is always
   * sync; `AWS::Lambda::EventSourceMapping` always async). Omitted where
   * only the resolved properties can tell (e.g. `AWS::Lambda::Permission`,
   * whose delivery depends on the invoking principal) — extraction logic
   * (Ticket A.6) infers it there.
   */
  delivery?: EdgeDelivery;
  /** Emit one edge per element of this array-valued property (e.g. one per listener action). */
  fanOut?: PropPath;
}

/**
 * One row of the type → role table (`rules.ts`). The table is DATA, not
 * logic: growing coverage means adding rows, never editing the
 * classification pass. Field applicability by role is enforced by
 * `__test__/rules.test.ts`, the table's "compiler".
 */
export interface TypeRule {
  /** Which of the four architectural roles this type plays. */
  role: Role;
  /** `component`/`container` only: the horizontal band it renders in. */
  layer?: ArchLayer;
  /** `component`/`container` only: normalized service key — drives the icon and display grouping. */
  service?: string;
  /** `container` only: which boundary kind Pass 2 (Ticket A.4) builds for this type. `account`/`region` are never type-derived — they come from PO Question 27's metadata convention. */
  containerKind?: 'vpc' | 'subnet' | 'cluster' | 'stack';
  /** `detail`/`connector`: candidate owner types to absorb into, highest priority first. A detail-role candidate is allowed — resolved transitively by Ticket A.5, and validated (in `rules.test.ts`) to always terminate at a component/container within depth 5. */
  absorbInto?: string[];
  /** `detail`/`connector`: which detail-panel section the absorbed resource appears under. */
  group?: AbsorbedGroup;
  /** `detail` only: resolve the owner by naming convention (e.g. Log Groups' `/aws/{service}/{name}`) when no edge connects them. */
  ownerByNamePattern?: string;
  /** `connector` only: how it becomes edge(s) before disappearing. */
  connector?: ConnectorSpec | ConnectorSpec[];
  /** Keep security/cost badges visible on the owner after absorption (e.g. NAT gateway cost surviving onto the VPC). */
  propagateBadges?: boolean;
  /** Display-label override; default derives from the resource's Name/tags. */
  labelHint?: string;
}

/**
 * The Architecture Generator's complete output: what to draw, plus the full
 * audit log accounting for every input node exactly once.
 */
export interface ArchitectureGraph {
  /** The visible components. */
  nodes: ArchNode[];
  /** The drawn relationships between them. */
  edges: ArchEdge[];
  /** The boundaries drawn around them. */
  containers: ArchContainer[];
  /** Complete audit log — every {@link GraphModel} node appears exactly once (the accounting invariant, asserted across the whole fixture corpus). */
  decisions: AbstractionDecision[];
  /** Resource types no rule matched, deduplicated — kept visible (never silently hidden) and reported so the rule table grows demand-driven. */
  unknownTypes: string[];
  /**
   * Every source {@link GraphModel} node id → the id of the arch element
   * (node or container) that represents it on the diagram. Built in Pass 5
   * (Ticket A.7) for Sprint 6/7: a search/blast-radius match on a hidden
   * resource highlights its owning arch element instead of failing
   * silently. Total: one entry per input node.
   */
  nodeIndex: Record<GraphNodeId, string>;
  /** Headline counts — always presented together ("62 components (529 details absorbed)"), never the component count alone. */
  stats: {
    /** How many {@link GraphModel} nodes went in. */
    sourceNodeCount: number;
    /** How many visible components came out. */
    componentCount: number;
    /** How many resources were absorbed into a component or container. */
    absorbedCount: number;
    /** How many edges were recovered from connector resources. */
    connectorEdgeCount: number;
  };
}
