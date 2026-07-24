# ADR 0009: Layer and direction inference, and the synthetic Internet/Users node

**Status:** Accepted
**Date:** 2026-07-23
**Related:** Sprint 3.5, Tickets A.8–A.9 (`src/architecture/layers.ts`,
`src/architecture/synthetic.ts`, `src/architecture/rules.ts`'s
`LAYER_ORDER`)

## Context

By the end of Pass 5 (ADR 0008), every surviving `ArchEdge` has a
`kind` (`containment`/`invocation`/`dataAccess`/`network`/`association`)
and a `source`/`target` — but that source/target is still whatever the
original `GraphEdge`'s direction happened to be, which for a plain
template reference is not a reliable flow signal. `Subnet → VPC` is
containment. `Lambda → Role` is configuration, not flow. But `Lambda →
DynamoDB` (via an environment variable) genuinely *is* flow, and the
template's own reference direction doesn't reliably tell these apart —
worse, two components can reference each other in both directions in the
same template (a real corpus case, `09-sam-apigw-lambda-dynamodb`'s `Api`
and `PutItemsFunction`), and only one of those directions is the
"real" one a human would draw as an arrow.

Separately, ADR 0007's four-role split has no way to represent something
that exists in every target reference diagram but in **no** CloudFormation
template at all: a "Users" or "Internet" box showing where traffic
enters the system — the PRD's own stated success criterion #1
("how does traffic enter the system, answerable at a glance").

## Decision

### Layers are already rule-assigned (ADR 0007); topology is used for exactly one further thing — direction

`inferDirection()` (Pass 6, `src/architecture/layers.ts`) runs last in
`generate()`, after Pass 5's reparent/dedupe, and touches only
`source`/`target`/`inferred`/`confidence` — never `kind`, never which
edges exist. Per edge kind:

| Kind | Rule |
|---|---|
| `containment` | Untouched — already nesting, never an arrow. |
| `invocation` | Untouched — the connector (ADR 0008) declared this direction explicitly, and it's correct even when layer order alone would suggest otherwise (e.g. `EventSourceMapping`'s `Queue → Function`, despite `integration` sitting after `compute` in layer order). |
| `network` | Untouched — declared source SG → target SG, as-is; this is reachability, not flow. |
| `dataAccess` | Reordered so the lower-layer-index endpoint (the accessor) becomes `source`. A tie is left as declared and is **not** flagged `heuristic` — a connector rule already chose the accessor side deliberately, independent of layer order. |
| `association` | Reordered by `LAYER_ORDER` index (`edge(0) → presentation(1) → auth(2) → api(3) → compute(4) → integration(5) → data(6)`; `monitoring`/`network`/`unassigned` sit outside this range and never participate in ordering). A tie — same layer, or either endpoint outside the ordered range — keeps the template's own reference direction and sets `confidence: 'heuristic'`. |

A flipped direction sets `inferred: true` on the edge, visible in the
detail panel — never silently presented as something the template
itself said.

### The known limitation is accepted and flagged, not hidden

Two same-layer components joined by a *direct* reference with no
mediating connector (two Lambdas referencing each other's ARNs directly,
say) have no reliable direction signal at all — layer order can't break
the tie because there's no difference to break, and there's no connector
to trust either. The template's own direction is kept, but marked
`confidence: 'heuristic'` rather than asserted as verified. This is
deliberate, not an oversight: `docs/developer-guide.md` and a dedicated
test (`layers.test.ts`'s "KNOWN LIMITATION" case, plus an end-to-end
`generate()` case) both assert this is flagged, explicitly **not** that
the resulting direction is correct.

### Flipping can newly collide two edges Pass 5 kept distinct — re-dedupe after direction, not just after reparenting

A genuine bug found via the corpus-wide reparent test, not anticipated in
advance: if a template has both an `Api → Fn` and a separate `Fn → Api`
association (both real, both surviving Pass 5's own dedupe, since they
have different `(source, target)` order and thus different keys),
flipping the backward one for layer order can land it on the exact same
key as the already-correct one. `inferDirection()` re-runs the same
union-not-discard provenance merge Pass 5 uses, after flipping — so
provenance from both never silently disappears. Caught by
`09-sam-apigw-lambda-dynamodb`'s real `Api`/`PutItemsFunction` pair, via
the pre-existing whole-corpus uniqueness invariant, not invented as a
hypothetical.

### The synthetic Internet/Users node: two independent detection paths, both excluded from the accounting invariant

`addSyntheticNodes()` (`src/architecture/synthetic.ts`) emits at most one
`Internet / Users` node (layer `edge`), only when a real ingress signal
is found, via two paths that don't overlap:

1. A `0.0.0.0/0`/`::/0` CIDR, either a standalone
   `AWS::EC2::SecurityGroupIngress` resource or an **inline**
   `SecurityGroupIngress` list on the `SecurityGroup` resource itself
   (the common real pattern in `examples/03-multi-stack-ecs-fargate` —
   no standalone Ingress resource exists there at all). Deliberately
   independent of Pass 4's connector mechanism, since `SecurityGroup` is
   a `detail`, not a `connector` — its inline rules are invisible to
   `connectors.ts` entirely.
2. Managed edge services that are public by default: `CloudFront::Distribution`
   unconditionally; API Gateway (REST/HTTP/V2/SAM) unless it declares a
   `PRIVATE` `EndpointConfiguration`. `examples/09-sam-apigw-lambda-dynamodb`
   has no security group anywhere in the template — path 1 alone would
   miss its public API Gateway entirely.

The node's `inferred: true` (a new, optional `ArchNode` field — absent,
never `false`, on every real node) and its own `decision.action:
'synthetic'` (a new `AbstractionDecision` action, used only on this one
node, never pushed into the corpus-wide `decisions` audit array) both
exist for the same reason ADR 0007's accounting invariant exists: nothing
in this pipeline is allowed to look template-derived when it isn't. The
whole-corpus accounting equation in `generate.test.ts` (nodes +
containers + absorbed === source node count) was updated to exclude
`inferred` nodes — a genuine correction once the synthetic node started
existing, not a loosening of the invariant itself.

## Alternatives Considered

**Full topological sort for layer assignment too, not just direction.**
Rejected — see ADR 0007's "Layers are rule-assigned" section; the same
cyclic/undefined-depth problem applies here even more directly, since
direction inference specifically needs to handle cycles gracefully
(two same-layer Lambdas calling each other) rather than being undefined
by them.

**Flag every `association` edge as `heuristic`, not just tied-layer
ones.** Rejected — would throw away real signal for the common,
correctly-orderable case (e.g. `Function → Table`, api layer 3 before
compute layer 4) by treating it identically to the genuinely ambiguous
tied case. The AC specifically wants the tie case flagged, not
association edges as a whole.

**Silently discard one of two colliding edges after a direction flip,
instead of re-deduping with provenance union.** Rejected on the same
principle ADR 0002 and Ticket A.7's own dedupe already established: an
edge existing because of two distinct real constructs must say so,
not silently present as if only one ever existed.

**Emit the synthetic node unconditionally (always present), rather than
only when a real signal is found.** Rejected — an architecture with no
public ingress at all (fully private VPC, no internet-facing anything)
genuinely has no "how does traffic enter" answer to show; forcing the
node in regardless would misrepresent a real architectural property
(this system has no public entry point) as if it always has one.

**Detect public ingress by inspecting `Fn::If`-gated or otherwise
unresolvable branches optimistically.** Not attempted — out of scope;
the existing parser-level "never guess on an unresolvable branch"
stance (tracked separately in `SPRINT-PLAN.md`'s A.11 findings) applies
here identically to everywhere else reference resolution matters.

## Consequences

- Any future `ArchEdgeKind` addition must decide which of these five
  direction-rule branches it falls into (or add a sixth) — `layers.ts`'s
  `inferDirection()` is now the single place that decision is made,
  never ad-hoc per-caller.
- The re-dedupe-after-flip step means Pass 6 is not purely a map over
  edges — any future change to `inferDirection()` must preserve the
  merge step or risk reintroducing the exact duplicate-edge bug this ADR
  documents finding.
- The synthetic node's exclusion from the accounting invariant is now a
  precedent: any *future* synthetic node (e.g. a prospective
  account/region boundary marker, explicitly scoped out of Ticket A.9 in
  favor of A.4's real `ArchContainer` account/region containers) must
  make the same explicit choice — participate honestly in accounting, or
  be explicitly and documentedly excluded, never silently counted as if
  it had a source resource.
- Two real, scoped-but-unfixed findings came out of validating this
  machinery against real fixtures (Ticket A.11's eyeball test): same-
  `logicalId` collisions across a multi-stack merge produce visually
  identical, undifferentiated labels, and a degraded `detail`/`connector`
  node that stays visible shows an uninformative `service: 'unknown'`
  rather than anything derived from its still-known `resourceType`. Both
  are rendering/labeling concerns for a future ticket, not this one.
