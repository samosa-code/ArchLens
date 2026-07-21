# ADR 0002: Graph node identity and edge model

**Status:** Accepted
**Date:** 2026-07-20
**Related:** Sprint 2, Ticket 2.1 (`src/graph/model.ts`, `src/common/types.ts`,
`src/common/interfaces.ts`)

## Context

Ticket 2.1 defines the schema every later sprint (rendering, search, blast
radius, diff) builds on — the PRD calls the graph model "the product"
itself. Getting it wrong is expensive to unwind later, so before writing
any code this ticket went through three rounds of scrutiny rather than one:

1. Fixture-based research across all 13 `examples/` templates (confirmed
   `DependsOn` usage in 10/13, ruled out `Metadata`-block intrinsics as a
   real edge source).
2. Reading AWS's own CloudFormation User Guide
   (`internal-docs/cfn-ug.md`), specifically to catch anything real-fixture
   sampling alone couldn't reveal — fixtures only show what template
   authors happened to use, not the full spec.
3. Explicit Product Owner sign-off (`internal-docs/SPRINT-PLAN.md`,
   Questions 4d and 4e) on the two genuine design forks that research
   surfaced, rather than the engineer silently picking a default.

## Decision

### Node identity: `${file}#${logicalId}`, never just the logical ID

Per PO Question 4d: two unrelated input templates that happen to declare a
resource with the same logical ID must produce two distinct
`GraphNode`s, not one merged node. `nodeId()` (`src/graph/model.ts`) is the
single formula every node and every edge target goes through — there is no
second place in the codebase that constructs a node identity independently
(the risk that motivated writing this down explicitly: silently merging
same-named-but-unrelated resources from different files would misrepresent
real infrastructure as connected when it isn't).

`GraphNode.file` doubles as "origin stack" for now — there's no separate
assumed-stack-name field on the node itself. The human-friendly assumed
stack name (PO Question 4b, e.g. for matching `AWS::StackName`-based export
names across templates) is a Ticket 2.2 concern for cross-stack *matching*,
not a Ticket 2.1 node-identity concern; conflating the two would make node
identity depend on a guess rather than the one thing that's always known
and unique — the file path.

### Edges are a discriminated union by `kind`, not one flat shape

`reference` (from `Ref`/`Fn::GetAtt` inside `Properties`), `dependsOn`
(from the `DependsOn` resource attribute), and `crossStackImport` (reserved
for Ticket 2.2/2.3's multi-template merge — not produced by this ticket's
single-template `buildGraph()`) are separate union members, each carrying
only the fields that make sense for it, rather than one `GraphEdge` shape
with a pile of optional fields. This is what lets later sprints add
`network`/`iam` edge kinds without reworking the two kinds that exist now.

**`DependsOn` is its own kind, not folded into `reference`.** `DependsOn`
bypasses `resolveValue()` entirely — CFN defines it as a bare logical-ID
string or list of strings, never an intrinsic call — so its targets need
their own existence check (`extractDependsOnEdges()`), separate from the
guarantee `resolveValue()` already provides for `Ref`/`Fn::GetAtt` (a
`resourceRef`/`attributeRef` only exists in a `ResolvedValue` tree if
`context.resources.has(name)` was already true when Sprint 1 resolved it —
verified directly by reading `intrinsics.ts:41-53` and `62-67` rather than
assumed). A `DependsOn` entry naming an undeclared resource produces a
`GraphWarning`, never a fabricated edge to a nonexistent node and never a
silently dropped entry — consistent with this project's "never silently
guess or drop" stance carried over from Sprint 1.

**Edges are never collapsed — one per property-path occurrence.** The same
target referenced twice in a resource's `Properties` (e.g. the same
security group listed twice in a list) produces two distinct `reference`
edges, each with its own `propertyPath`, not one deduplicated edge.
Collapsing would hide that the template author wrote two references, which
may matter later (e.g. one inside a conditional list entry and one not).
The same non-collapsing behavior applies to `DependsOn`: the same target
listed twice produces two `dependsOn` edges. Both are locked in by a
mutation-tested case, not just a happy-path one (deduplicating via a `Set`
was tried deliberately during development and confirmed to break the
"not collapsed" test, rather than assumed to be caught).

**`reference` edges preserve *how* the reference was made.** `via: {kind:
'ref'}` vs `via: {kind: 'getAtt', attribute}` — a `Ref` and a
`Fn::GetAtt` to the same target are architecturally different (whole-
resource identity vs. one specific attribute), and collapsing them into an
undifferentiated "points at X" edge would lose information later sprints
(diagram edge labels, blast-radius specificity) may need.

### `Fn::ImportValue`'s `exportName` is a leaf, not walked for edges

A `Ref` nested inside an `Fn::ImportValue` export-name expression (e.g.
`!ImportValue { Fn::Join: [":", [!Ref Foo, "suffix"]] }`) does **not**
produce a `reference` edge to `Foo`. That `Ref` computes a cross-stack
*lookup key* — what export name to search for — not a same-template
architectural dependency; walking into it would produce a false-positive
edge to a resource this property never actually consumes a value from.
This is a real edge case, not a hypothetical: confirmed by a dedicated
mutation-tested case (recursing into `importValueRef.exportName` was tried
and confirmed to make the "does NOT produce an edge" test fail, proving the
test isn't vacuous).

### `Metadata` is never walked for edges

Real fixtures were checked directly (not assumed) during Ticket 2.1
research: apparent `Ref`/`Fn::GetAtt` usage inside `Metadata` blocks in
`01-simple-lambda` and `09-sam-apigw-lambda-dynamodb` turned out to be a
false positive from a mis-scoped grep — the actual `Metadata` content is
non-referential (`cfn-lint`/`guard` suppression annotations, build
metadata), not real intrinsic usage. `buildGraph()` only resolves and walks
`Properties`; `Metadata` is read for nothing graph-related.

### `Fn::GetStackOutput` is recognized but deliberately unresolved (PO Question 4e)

Documentation research (`internal-docs/cfn-ug.md`) surfaced
`Fn::GetStackOutput` — a newer alternative to `Export`/`Fn::ImportValue` for
reading another stack's outputs (including cross-account/cross-Region)
without requiring an explicit `Export`; a *weak*, unenforced reference,
unlike `Fn::ImportValue`'s strong one. Two problems ruled out implementing
it now: it's used by none of the 13 `examples/` fixtures, and the provided
user-guide document never actually states its argument syntax — every one
of its 9 mentions points to a separate "CloudFormation Template Reference
Guide" document not available to this project. Implementing it now would
mean guessing at syntax the available source doesn't confirm.

Rather than let it fall through `resolveValue()`'s generic pass-through
(the treatment every genuinely-unimplemented intrinsic like `Fn::Base64`
gets), `intrinsics.ts` gained one explicit case returning `{kind:
'unresolved', reason: 'Fn::GetStackOutput is not yet supported'}` — because
unlike `Fn::Base64`, this one represents a real cross-stack reference that
would otherwise silently vanish into an opaque, unrecognized object rather
than being flagged. Full resolution is out of Sprint 2 scope, tracked as a
follow-up ticket.

## Alternatives Considered

**Flat `GraphEdge` interface with an optional `propertyPath`/`attribute`/
`exportName` on every kind.** Rejected — TypeScript's discriminated union
gives compile-time proof that, say, a `dependsOn` edge can never
accidentally carry a `propertyPath` meant for `reference` edges, at zero
runtime cost. A flat shape would need every consumer to re-derive that
invariant by convention.

**Collapsing duplicate edges (same source/target/kind) into one.** Rejected
per the resolved design fork above — considered, and specifically tested
against, since it's the more "obviously tidy" option a graph-visualization
mental model nudges toward. Locked in as *not* the behavior via a
mutation-tested case rather than left to accidentally regress later.

**Folding `DependsOn` into `reference` edges.** Rejected — `DependsOn`
targets need independent existence validation (it bypasses `resolveValue`
completely), and conflating "the resource is used as a property value" with
"the resource is only an ordering constraint" would lose real semantic
information a later "why does this depend on that" query needs.

## Consequences

- `buildGraph(file, template)` is single-template only, by design — merging
  N templates' `GraphModel`s (including producing `crossStackImport` edges
  by matching `importValueRef.exportName` against another template's
  `Export.Name`) is Ticket 2.2/2.3's job, operating one layer up.
- Every declared `Resources` entry always becomes a node, regardless of its
  `Condition` outcome — `excluded`/`unknown` resources are never omitted,
  only flagged via `GraphNode.inclusion` (PO Question 1, carried forward
  unchanged from Sprint 1's `ResourceInclusion`).
- `GraphNode` carries no assumed-stack-name field; anything that needs one
  (Ticket 2.2's export-name matching) computes and owns it separately
  rather than it living on the node schema this ticket defines.
- Adding a new edge kind (e.g. a future `network`/`iam` kind) is additive to
  the `GraphEdge` union — existing code that pattern-matches on specific
  `kind` values (not an exhaustive `switch`) is unaffected, the same
  extensibility property Sprint 1's architecture review already confirmed
  for `ResolvedValue` in `docs/parser-architecture.md`.
- `Fn::GetStackOutput` full support (matching it to an actual edge) remains
  a known gap — see `LIMITATIONS.md`.
