# ADR 0007: Architecture abstraction layer — the four-role split

**Status:** Accepted
**Date:** 2026-07-23
**Related:** Sprint 3.5, Tickets A.1–A.5 (`src/architecture/classify.ts`,
`src/architecture/containers.ts`, `src/architecture/ownership.ts`,
`src/architecture/rules.ts`)

## Context

Sprint 2's `GraphModel` is a faithful, nothing-discarded 1:1 map of a
CloudFormation template: one `GraphNode` per declared resource. That is
exactly right for Sprint 2's job and exactly wrong as a diagram — a real
SAM application's single Lambda function typically brings an execution
role, one or more IAM policies, a log group, a `Lambda::Permission`, and
an API Gateway method/deployment/stage along with it. A 1:1 render (what
`fromGraphModelRaw.ts` still produces, deliberately, for `--raw`) shows
all of that as equally-weighted boxes — the actual architecture (three
services talking to each other) is buried in a crowd of implementation
detail no human draws by hand.

The project's own state doc and PRD are explicit that solving this ("noise
reduction / clustering") is expected to be the most iteration-heavy,
subjective part of the whole project — Sprint 3.5 exists specifically to
build a real reduction stage (`GraphModel → ArchitectureGraph`) in front
of the renderer, rather than attempt clustering as a rendering-layer
afterthought.

## Decision

### Four roles, not a binary show/hide flag

Every `GraphModel` node is classified into exactly one of:

- **`component`** — its own visible box (Lambda, SQS, DynamoDB, an API
  Gateway REST API). What a human architect would actually draw.
- **`container`** — a boundary drawn *around* other things, never a box
  itself (VPC, Subnet, ECS Cluster, a nested `AWS::CloudFormation::Stack`).
- **`detail`** — real infrastructure, but never wanted as its own box;
  absorbed into an owning component/container's detail panel (IAM Role,
  Log Group, Route Table, a Lambda Version/Alias).
- **`connector`** — a resource whose *only* architectural meaning is the
  edge it implies between two other components (`Lambda::Permission`,
  `ApiGateway::Method`, an ELB Listener/ListenerRule). This is its own ADR
  (0008) — the single most important correction the whole sprint makes.

A binary "show/hide" model can't express this: a `detail` and a
`connector` are BOTH hidden as boxes, but a connector's hiding must
happen *after* it has produced a real edge, while a plain detail's hiding
is unconditional. Conflating the two — treating a connector as a plain
detail — is the one failure mode this project treats as unacceptable: it
silently deletes real architecture (see ADR 0008).

### The rule table is data, not logic (`src/architecture/rules.ts`)

`classify()` (Pass 1) is a fixed, small function: rule-table lookup →
structural heuristic → `kept-unknown` fallback. Every ounce of AWS-
specific knowledge (~165 entries at time of writing, grown substantially
by Ticket A.11's corpus validation) lives in `RULES: Record<string,
TypeRule>`, never in `classify.ts` itself. Growing coverage for a new
resource type means adding a row; it never means adding a branch to the
classification pass. `rules.test.ts` is the table's own "compiler" —
role/field consistency, ownership-chain termination, and structural-
heuristic suffix liveness are all asserted structurally against the table
itself, catching a bad row at test time rather than misclassifying
quietly at runtime.

### The structural fallback heuristic is narrow and asymmetric on purpose

AWS has roughly 1,200 resource types; the rule table covers a few hundred
at best. An unruled type falls through to one heuristic: absorbed as a
`detail` only if **all** of (1) its type's last path segment matches a
short, corpus-exercised suffix list (`PLUMBING_SUFFIXES` — pruned from
the spec's drafted 19 entries down to 3 after real-fixture testing showed
16 were dead, their common types already ruled), (2) it has exactly one
non-detail neighbour, (3) nothing else references it except that
neighbour. Anything else is **kept visible**, `layer: 'unassigned'`,
`confidence: 'fallback'`, and reported via `--explain`'s `unknownTypes`
worklist.

The failure policy is deliberately asymmetric: a missing rule produces a
slightly noisier diagram — annoying, but visible and fixable by adding a
row. An over-eager heuristic silently deletes a real component from the
diagram — invisible, and destroys trust in the tool the first time
someone notices their database is missing. Given that asymmetry, the
heuristic errs noisy every time the two failure modes trade off against
each other.

### Layers are rule-assigned, never topology-derived

Each `component`/`container` rule declares a static `layer` (`edge`,
`presentation`, `auth`, `api`, `compute`, `integration`, `data`,
`monitoring`, `network`, `unassigned`). Topological depth was considered
and rejected as the layering signal: a Lambda that writes to a bucket
that triggers another Lambda has no clean topological depth, and any
cyclic reference (common — a Lambda referencing another Lambda's ARN
both ways, or a security group's own self-referencing ingress rule) makes
topological ordering undefined outright. A static type → layer table is
deterministic, debuggable one row at a time, and matches how AWS's own
reference architecture diagrams are actually organized (by service kind,
not graph depth). Topology is still used, but for exactly one narrower
thing — flow *direction* between two already-layered components — which
is ADR 0009's subject.

### Ownership resolution never guesses — it either resolves or stays visible

A `detail`'s owner is found via, in order: (1) a rule-declared
`absorbInto` neighbour search, (2) a naming convention
(`ownerByNamePattern`, for resources like Log Groups that often have no
edge to their owner at all), (3) a transitive chase through other
details, depth-capped and cycle-detected. If none resolve, the node stays
**visible** (`kept-unknown`), never silently dropped and never guessed
onto an arbitrary neighbour. The accounting invariant this whole layer is
built around — `decisions.length === graphModel.nodes.length`, asserted
corpus-wide — is what keeps this promise honest: every input resource
has exactly one recorded fate, always inspectable via `--explain`.

## Alternatives Considered

**A single `hidden: boolean` flag instead of four roles.** Rejected —
can't express "hidden, but only after producing an edge" (connectors)
distinctly from "just hidden" (details), and can't express "not a box,
but a boundary" (containers) at all. Would have pushed connector logic
into ad-hoc special-casing wherever hiding happens, rather than one
explicit role the rest of the pipeline dispatches on.

**Heuristic-only classification, no rule table.** Rejected outright by
the project's own posture: a purely structural heuristic (suffix + degree
+ reference count) has no way to know that `AWS::Lambda::Permission` is
architecturally load-bearing (an edge) while `AWS::Lambda::Version` is
pure noise — both are equally "some resource with one neighbour." Only
per-type domain knowledge can make that call safely, which is exactly
what a rule table is for.

**Topological/graph-depth-based layering.** Rejected — see "Layers are
rule-assigned" above. Produces garbage on the common cyclic and
non-linear patterns this project's real corpus is full of.

**Always render every resource, rely on client-side clustering/collapse
UI instead of a server-side abstraction pass.** Considered, since it
defers the hard classification problem to interaction design. Rejected
because it doesn't answer the PRD's own stated goal ("readable at a
glance," success criterion #1) — a first paint of 60+ boxes for a
3-service serverless app fails at-a-glance readability before any
collapsing interaction happens; the reduction has to happen before first
render, not as a post-hoc UI affordance.

## Consequences

- Every future resource-type addition is a `rules.ts` row, never a
  `classify.ts`/`containers.ts`/`ownership.ts` code change — confirmed in
  practice by Ticket A.11, which added ~45 new rows to close real corpus
  gaps without touching any of the three passes' logic.
- The `kept-unknown`/`unassigned`/`fallback` triple is a first-class,
  permanent outcome, not an error state — a legitimate, honestly-reported
  gap in coverage, not a bug to eliminate. `--explain`'s `unknownTypes`
  worklist (ranked by real corpus frequency, Ticket A.10) is what turns
  that gap into a demand-driven backlog rather than a guess.
- The accounting invariant is binding on every future pass this pipeline
  gains (Pass 6's direction inference, the synthetic Internet/Users node)
  — each new addition either participates in that invariant correctly or
  is explicitly, documentedly excluded from it (as the synthetic node is
  — see ADR 0009 and the corresponding developer-guide entry).
- The rule table's data-not-logic property is what made Ticket A.11's
  corpus-validation loop back into A.2 fast and low-risk: growing
  coverage was purely additive rows, verified structurally by
  `rules.test.ts` before ever running against real fixtures.
