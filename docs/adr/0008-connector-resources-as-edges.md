# ADR 0008: Connector resources become edges, not absorbed details

**Status:** Accepted
**Date:** 2026-07-23
**Related:** Sprint 3.5, Tickets A.6–A.7 (`src/architecture/connectors.ts`,
`src/architecture/reparent.ts`, `src/architecture/rules.ts`'s
`ConnectorSpec`/`Endpoint` schema)

## Context

This is the single most important design decision in Sprint 3.5, and the
spec's own §1 explicitly frames it as a correction to a naive first
instinct: absorb every non-`component`/`container` resource as a hidden
`detail` on some owner, full stop.

That instinct is wrong in a way that isn't obvious until you look at a
real fixture. In `examples/14-diverse-corpus/apigateway-lambda-integration.yaml`,
there is **no direct `GraphEdge` from the REST API to the Lambda function
at all.** The relationship — "API Gateway routes requests to this
Lambda" — exists only as two separate pieces of plumbing: an
`AWS::ApiGateway::Method`'s `Integration.Uri` (pointing at the function's
invoke ARN) and an `AWS::Lambda::Permission` (granting API Gateway
permission to invoke it). Absorb both of those as plain hidden `detail`s
— which is exactly what "hide everything that isn't a component" naively
does — and the single most important edge in the entire diagram (the one
answering "what does this API actually do") simply doesn't exist
anymore. Not hidden: **gone**. The same pattern recurs for SQS/SNS →
Lambda (`EventSourceMapping`, `Subscription`), ALB/NLB → target
(`Listener`/`ListenerRule`/`TargetGroup`), and IAM-policy-granted access
between two components (`Lambda::Permission` again, resource policies).

## Decision

### A fourth role: `connector` — hidden as a box, but emits its edge first

A `connector`-role resource is absorbed exactly like a `detail` (never
its own box), but its `rules.ts` entry additionally carries a
`ConnectorSpec`: a `source`/`target` pair of `Endpoint`s (`{from: 'prop',
path}` — resolve a reference at a property path; `{from: 'owner'}` — the
resource this connector attaches to; `{from: 'principal', path}` — an AWS
service principal, v1-unsupported, degrades safely; `{from: 'internet'}`
— the synthetic node, ADR 0009's neighbour concern), an `ArchEdgeKind`,
a label, and optionally a static `delivery` (sync/async).

### Pass 4 runs the connector spec against the INTACT graph, before Pass 5 removes anything

This ordering is the entire mechanism, and the spec calls it out
explicitly as "the single easiest way to silently lose half your edges"
if reversed: Pass 4 (`extractConnectorEdges`) walks every connector's
spec while every original node and edge still exists, emitting
`ArchEdge`s with full provenance back to the connector resource and its
source line. Only **after** every connector has had its chance to speak
does Pass 5 (`reparentAndDedupe`) rewrite/drop/absorb the underlying
plumbing nodes. Emit-then-remove, never remove-then-infer.

### Endpoint resolution rides existing `GraphEdge`s, never a naive property walk

`resolveEndpoint({from: 'prop', path})` matches against the graph's
already-extracted `reference`/`crossStackImport` edges (whose
`propertyPath` the parser recorded down to array-index precision) via a
numeric-tolerant prefix matcher, rather than re-walking the resource's
raw resolved properties independently. Two real consequences fall out of
this as a direct mechanism property, not as hand-written special cases:

- A reference nested inside a partially-resolved `Fn::Join`/`Fn::Sub`
  still resolves, because the parser already found it and recorded the
  path.
- A literal ARN string or a `'*'` wildcard **never** produced a graph
  edge in the first place, so it can never produce a connector edge
  either — PO Question 19's "never emit an edge on a wildcard IAM
  `Resource: '*'`" is true by construction, not because of an `if
  (resource === '*') continue` guarded against it. Confirmed directly
  against `examples/07-vulnerable-cfngoat`'s real wildcard IAM policy.

### A connector whose endpoints don't resolve degrades to a plain absorbed detail — never a guessed edge

If a connector's `source`/`target` don't resolve to a surviving
component (e.g. an `SNS::Subscription` whose `Endpoint` is a `Ref` to a
`Parameter`, not a resource — a real case in `sns-topic.yaml`), it emits
nothing and falls back to being absorbed as an ordinary `detail` into
whichever endpoint *did* resolve, or stays `kept-unknown` if neither did.
Never a fabricated edge to a best-guess target.

### Reparenting skips an *emitted* connector's own reference edges, but not a *degraded* one's

Ticket A.7's refinement, beyond the spec's literal Pass 5 table: once a
connector has successfully emitted its semantic edge (`invokes`, `routes
to`, ...), its own raw `reference`/`dependsOn` edges (the very plumbing
that produced that edge) are skipped during reparenting — otherwise every
connector-derived edge would get a redundant, unlabeled `association`
arrow drawn right beside it, doubling up on the same relationship. A
*degraded* connector (no edge emitted) has no such redundancy risk, so
its plumbing reparents normally, exactly like any plain detail's.

## Alternatives Considered

**Treat everything as a plain `detail`, infer missing edges heuristically
from naming/co-location later.** Rejected as the original naive
approach this ADR corrects — see Context. A post-hoc heuristic patch
over a fundamentally lossy first pass is strictly worse than not losing
the information in the first place.

**Model connectors as ordinary components, just small/de-emphasized
ones.** Rejected — an `AWS::Lambda::Permission` or `AWS::ApiGateway::Method`
has no architectural meaning of its own a human would want to click on;
showing it as a (even minor) box reintroduces exactly the plumbing-noise
problem ADR 0007 exists to solve, just with extra steps.

**Resolve connector endpoints via a fresh, independent property/AST walk
instead of riding existing `GraphEdge`s.** Rejected — would duplicate the
parser's own intrinsic-resolution and path-tracking work in a second
place, with a second chance to disagree with it, and would lose the
"never produces an edge, therefore never emits one" wildcard guarantee
that falls out for free when connectors only ever look at edges the
parser already proved exist.

**Always emit an edge for a connector, guessing a target when one doesn't
cleanly resolve (e.g. "the only other Lambda in the stack").** Rejected —
directly violates the project's "never silently guess" posture; a wrong
guessed edge is strictly worse than an honestly absent one, since a
missing edge is at least visible as a gap (`kept-unknown`) while a wrong
edge looks authoritative.

## Consequences

- Every future connector-type addition to `rules.ts` must specify its
  `ConnectorSpec` alongside `absorbInto` — `rules.test.ts` validates both
  are present and well-formed for every `connector`-role entry.
- Reversing Pass 4/Pass 5 order is now a structurally-guarded invariant
  (`generate.ts`'s orchestration, plus the whole-corpus reparent test)
  — not just a comment warning future readers not to reorder it.
- Endpoint resolution's dependence on existing `GraphEdge`s means a
  connector can only ever emit an edge to something the parser already
  proved is referenced — this is a feature (never fabricates), but it
  also means a reference the parser can't resolve (an unresolvable
  `Fn::If` branch, PO-question-tracked in `SPRINT-PLAN.md`'s A.11
  findings) silently caps what a connector can find, same as it caps
  ordinary reference edges.
- Two real rule-table corrections (Ticket A.6, driven by real-fixture
  testing rather than assumption) had to relax an earlier ticket's own
  "absorbInto is never a connector" test invariant once transitive
  connector chains (`ListenerRule → Listener → LoadBalancer`) turned out
  to be a real, common pattern — documented in `SPRINT-PLAN.md` and
  `docs/developer-guide.md` rather than silently patched.
