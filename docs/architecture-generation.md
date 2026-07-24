# Architecture Generation

Sprint 3.5's deliverable: turn Sprint 2's raw, nothing-discarded
`GraphModel` into a reduced, human-readable `ArchitectureGraph` —
most CloudFormation resources (IAM roles, policies, log groups, API
Gateway methods...) either disappear into the component they belong to,
or become an edge between two components, rather than each drawing its
own box. This is the stage the spec's own §1 identifies as the actual
hard problem: a 1:1 render of a real serverless app shows 20+ equally-
weighted boxes for what a human would draw as three services talking to
each other.

**Full design rationale:** [ADR 0007](adr/0007-architecture-abstraction-layer.md)
(the four-role split: component/container/detail/connector, and why
layers are rule-assigned, not topology-derived), [ADR 0008](adr/0008-connector-resources-as-edges.md)
(the single most important decision in the sprint — connector resources
become edges, not absorbed details), [ADR 0009](adr/0009-layer-and-direction-inference.md)
(direction inference, and the synthetic Internet/Users node). This
document is the "how it works" companion, walking the six passes in
order.

## Module map

| Module | Pass | Responsibility |
|---|---|---|
| `architecture/types.ts` | — | `ArchNode`/`ArchEdge`/`ArchContainer`/`ArchitectureGraph`/`TypeRule`/`ConnectorSpec`/`Endpoint` — the whole stage's type contract |
| `architecture/rules.ts` | — | `RULES: Record<string, TypeRule>` — the type → role table (data, not logic); `LAYER_ORDER`; `PLUMBING_SUFFIXES` |
| `architecture/classify.ts` | 1 | `classify()` — rule lookup → structural heuristic → `kept-unknown` fallback |
| `architecture/containers.ts` | 2 | `buildContainers()` — `container`-role nodes become `ArchContainer`s; nesting from reference edges; account/region containers (PO Question 27's `Metadata: ArchLens` convention) |
| `architecture/ownership.ts` | 3 | `resolveOwnership()` — rule-neighbour / naming-convention / transitive-chase strategies for `detail` owners |
| `architecture/connectors.ts` | 4 | `extractConnectorEdges()` — runs every connector's `ConnectorSpec` against the still-intact graph |
| `architecture/reparent.ts` | 5 | `reparentAndDedupe()` — rewrites edges onto surviving owners; dedupes by `(source, target, kind)`, provenance unioned |
| `architecture/layers.ts` | 6 | `inferDirection()` — layer-index-driven direction inference; re-dedupes after any flip |
| `architecture/synthetic.ts` | 6 | `addSyntheticNodes()` — the Internet/Users node, when a real ingress signal is found |
| `architecture/metadata.ts` | — | `readFileAnnotations()` — the `Metadata: ArchLens: {account, region}` convention Pass 2 consumes |
| `architecture/generate.ts` | — | `generate(graph, options?): ArchitectureGraph` — orchestrates all six passes; the pipeline's single public entry point |
| `architecture/explain.ts` | — | `explainReport()` — the `--explain` report (every `AbstractionDecision`, `unknownTypes` ranked by frequency) |
| `architecture/demo.ts` | — | `npm run arch:demo` — manual-verification entry point against a real 5-template merge |
| `architecture/corpus-report.ts` | — | `npm run arch:corpus-report` — per-fixture reduction ratio/rule coverage/unknown-type frequency across the full corpus |

## Pipeline

```
GraphModel (Sprint 2's 1:1 resource graph)
     │
     ▼
Pass 1  classify()             — role per node: component / container / detail / connector / kept-unknown
     │
     ▼
Pass 2  buildContainers()      — container nodes → ArchContainers, with nesting
     │
     ▼
Pass 3  resolveOwnership()     — owner per detail/connector node (never guessed — resolves or stays visible)
     │
     ▼
Pass 4  extractConnectorEdges()  — connector specs run against the INTACT graph (ADR 0008)
     │                             emits ArchEdges; connectors that can't resolve degrade to details
     ▼
Pass 5  reparentAndDedupe()    — rewrite edges onto survivors; dedupe, provenance UNIONED never discarded
     │
     ▼
Pass 6  inferDirection()       — layer-index-driven direction (ADR 0009); re-dedupe after any flip
        addSyntheticNodes()    — Internet/Users, only when a real ingress signal is found
     │
     ▼
ArchitectureGraph { nodes, edges, containers, decisions, unknownTypes, nodeIndex, stats }
```

Every pass is deterministic and runs in this fixed order inside
`generate()` — reversing Pass 4 and Pass 5 is called out explicitly in
ADR 0008 as the single easiest way to silently lose real edges.

## Pass 1 — Classify (`classify.ts`)

Every `GraphModel` node gets a role via rule-table lookup, then the
structural fallback heuristic, then `kept-unknown`. Records one
`AbstractionDecision` per node — the **accounting invariant**
(`decisions.length === graph.nodes.length`, asserted corpus-wide) is
binding on this pass and every one after it. See ADR 0007 for the
four-role design and the fallback heuristic's asymmetric failure policy
(missing rule = noisy but fixable; over-eager heuristic = silently
destroys trust — the heuristic errs noisy every time).

`unknownTypeCounts` (per-type instance frequency across the input) feeds
`--explain`'s worklist (Ticket A.10) — this is the mechanism that turned
Ticket A.11's corpus validation from a one-off audit into a genuinely
demand-driven rule-table backlog.

## Pass 2 — Build containers (`containers.ts`)

`container`-role nodes (VPC, Subnet, ECS/EKS Cluster, nested
`CloudFormation::Stack`) become `ArchContainer`s. Nesting comes from
existing `reference` edges (a Subnet's `VpcId` ref); container-absorbed
details (route tables, IGW, NAT, ACLs, security groups) attach here
rather than to a component. Deepest-referenced-container wins when a
node's containment chain is ambiguous.

Account/region containers are synthetic-in-the-sense-of-not-a-real-
resource but structurally ordinary `ArchContainer`s (`kind: 'account' |
'region'`) — built only when the merged input's declared accounts/regions
actually *span* more than one value (PO Question 27's `Metadata: ArchLens:
{account, region}` convention; `readFileAnnotations()` in `metadata.ts`).
Validated against a purpose-built synthetic fixture,
`examples/15-multi-account-hub-spoke/`, since no real corpus fixture
exercises multi-account/region on its own.

## Pass 3 — Resolve ownership (`ownership.ts`)

For each `detail`/`connector` node, in order: (1) rule-declared
`absorbInto` neighbour search (both directions, one hop, priority
order), (2) naming convention (`ownerByNamePattern`, e.g. Log Groups'
`/aws/{service}/{name}`), (3) transitive chase through other
detail/connector nodes, depth-capped at 5 and cycle-detected. No match →
`kept-unknown`, visible, with an honest reason — never guessed onto an
arbitrary neighbour.

## Pass 4 — Emit connector edges (`connectors.ts`)

Runs every `connector`-role node's `ConnectorSpec` while the graph is
still fully intact — the ordering ADR 0008 is built around. Endpoint
resolution rides the graph's own already-extracted reference edges
(numeric-tolerant path matching), never a fresh property walk — which is
also what makes "never emit on a wildcard `Resource: '*'`" (PO Question
19) fall out of the mechanism rather than needing a special case.
Sync/async delivery is either statically declared per type, or (for
`Lambda::Permission`) inferred from the invoking principal
(`s3`/`sns`/`sqs`/`events`/`iot`/`logs`/`config`/`ses` → async, else
sync). A connector whose endpoints don't resolve degrades to a plain
absorbed detail — never a guessed edge.

## Pass 5 — Reparent edges (`reparent.ts`)

Rewrites every original edge whose endpoint was absorbed onto the
surviving owner, per the spec's table (`A → X` absorbed into `O` becomes
`A → O`; both endpoints absorbed into the same owner is dropped as
internal; a resulting self-edge is dropped; a container endpoint becomes
`containment`, nesting, never an arrow). Then dedupes everything
(reparented originals + Pass 4's connector edges) by `(source, target,
kind)`, **unioning** `derivedFrom` provenance rather than discarding
duplicates — the same lesson the render layer's dagre-multigraph bug
taught this project once, applied here by design so the detail panel can
say "this edge exists because of these N constructs at these N source
lines."

One deliberate refinement beyond the spec's literal table: an *emitted*
connector's own reference edges are skipped (its plumbing already became
a semantic edge in Pass 4); a *degraded* connector's edges reparent
normally, like any detail's.

## Pass 6 — Layers, direction, synthetic nodes (`layers.ts`, `synthetic.ts`)

Layers themselves are already rule-assigned (Pass 1/ADR 0007); this pass
only reorders edge endpoints where topology gives a real signal, per
`ArchEdgeKind` (see ADR 0009 for the full per-kind table and the
documented same-layer/no-connector limitation). A flip sets `inferred:
true`; flipping can newly collide two edges Pass 5 kept distinct, so this
pass re-runs the same union-not-discard merge after any flip — a real
bug found via the whole-corpus test, not anticipated ahead of time.

The synthetic `Internet / Users` node (ADR 0009) is added last, only
when a real ingress signal is found (a public `0.0.0.0/0`/`::/0` security
group rule — standalone or inline — or a managed edge service that's
public by default). Deliberately excluded from the `decisions` audit
array and from `stats.sourceNodeCount`/`absorbedCount` accounting: it has
no source `GraphModel` node to account for.

## `--explain` and `--raw` (`explain.ts`, `fromGraphModelRaw.ts`)

`explainReport(arch)` dumps every `AbstractionDecision` (one line per
source node, accounting-invariant-complete) plus `unknownTypes` ranked by
frequency — the mechanism that turned Ticket A.11's corpus validation
into a demand-driven backlog instead of a guess. `fromGraphModelRaw.ts`
(renamed from `fromGraphModel.ts`, zero logic change, locked by a
snapshot regression test) is the original Sprint 2 1:1 projection,
preserved exactly for `--raw` (PO Question 21: a fully supported,
documented flag, not a debug aid) and future drill-down.

**Scope note:** neither is wired to a real CLI flag yet. `cli.ts` is
still Sprint 2's summary-only demo entry point — turning these into
actual `--explain`/`--raw`/`--layer`/`--hide-monitoring` argv flags is
Ticket 3.4, explicitly paused until Sprint 3.5 completes. This sprint
delivered the module-level capability those flags will call.

## Testing approach

Every pass has synthetic unit tests for edge cases the real corpus can't
cleanly isolate (transitive-chain depth/cycle limits, container-nesting
priority order) alongside real-fixture tests for the common cases, plus
a whole-corpus integration test per pass asserting its own invariant
holds across every real template on disk (no self-edges, unique
`(source, target, kind)`, `nodeIndex` total and closed, zero crashes).
Every non-trivial piece of logic was mutation-tested during development
— deliberately broken (a check disabled, an ordering reversed, a merge
skipped), confirmed to fail the relevant test, then reverted; several
mutations surfaced real gaps in the test suite itself (not just the
implementation), which were fixed by strengthening the test before
re-confirming the mutation was caught.

`src/architecture/__test__/corpusHelpers.ts` is the shared, recursive
real-fixture discovery used by every "whole corpus" test — replacing five
independently-duplicated, all identically-wrong flat directory scans
that silently merged two curated example groups
(`03-multi-stack-ecs-fargate`, `13-checkov-security-rule-pairs`, both of
which nest every template in subdirectories with no flat top-level file)
as empty graphs across their entire history. Found while building Ticket
A.11's corpus report, fixed once rather than patched five times.

## Corpus validation results (Ticket A.11)

Run `npm run arch:corpus-report` for the live, per-fixture numbers.
Summary at time of writing:

- **Zero crashes:** 0/67 individual `14-diverse-corpus` templates, 0/14
  curated example groups.
- **Rule coverage:** 98.5% of resource instances across the corpus hit an
  explicit rule (target: ≥90%). Measured at the `classify()` level — a
  ruled type whose *owner* fails to resolve still correctly counts as
  "ruled," a real methodology fix worth ~12 points on the very same table
  before any new rule was added (see `SPRINT-PLAN.md`'s A.11 findings).
- **Reduction ratio, SAM/serverless fixtures:** 58.7% aggregate (target:
  ≥85%). **Known, documented deviation** — every SAM fixture in the
  corpus now has 100% rule coverage and 0 unknown types; the shortfall is
  input sparsity, not missing rules. SAM's transform generates most of
  the "noise" this tool absorbs (execution roles, log groups,
  permissions) at *deploy time*, after this tool's static parser has
  already read the source template — several real fixtures genuinely
  have nothing left in the template to hide. Root-caused, not silently
  lowered; see `SPRINT-PLAN.md` for the full writeup.
- **3-fixture eyeball test** (`01-simple-lambda`,
  `09-sam-apigw-lambda-dynamodb`, `03-multi-stack-ecs-fargate`): two real
  findings, both scoped as follow-ups rather than fixed in Sprint 3.5—
  same-`logicalId` collisions across a multi-stack merge produce visually
  identical labels, and a degraded `detail`/`connector` node that stays
  visible shows an uninformative `service: 'unknown'` rather than
  anything derived from its still-known `resourceType`.

## Related documents

- [ADR 0007: Architecture abstraction layer — the four-role split](adr/0007-architecture-abstraction-layer.md)
- [ADR 0008: Connector resources become edges, not absorbed details](adr/0008-connector-resources-as-edges.md)
- [ADR 0009: Layer and direction inference, and the synthetic Internet/Users node](adr/0009-layer-and-direction-inference.md)
- [`docs/graph-architecture.md`](graph-architecture.md) — Sprint 2's
  `GraphModel` this stage consumes
- [`docs/render-architecture.md`](render-architecture.md) — the renderer
  this stage will feed once Ticket 3.4's CLI wiring lands (currently
  still consuming `GraphModel` directly via `fromGraphModelRaw.ts`)
- [`docs/developer-guide.md`](developer-guide.md) — project-wide doc index
- `internal-docs/SPRINT-PLAN.md` — the full A.1–A.11 ticket history,
  Product Owner decisions (Questions 17–27), and Ticket A.11's complete
  findings writeup
