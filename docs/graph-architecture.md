# Graph Architecture

Sprint 2's Ticket 2.1 deliverable: turn one already-parsed template (Sprint
1's `AstNode`) into a `GraphModel` — nodes for every declared resource,
edges for every reference between them. Ticket 2.2's export symbol table
(`graph/exports.ts`) indexes `Outputs`/`Export` values across N templates.
Ticket 2.3 (`graph/merge.ts`) combines both into one merged `GraphModel`,
resolving `Fn::ImportValue` calls into `crossStackImport` edges against
that table. Ticket 2.4 (`src/cli.ts`) wires a glob of file paths on disk
through the whole pipeline down to one summarized `GraphModel` — the data
layer's end-to-end demo; no rendering yet.

**Full design rationale:** [ADR 0002](adr/0002-graph-node-identity-and-edge-model.md)
(node identity, edge model — Ticket 2.1), [ADR 0003](adr/0003-export-symbol-table-assumed-values.md)
(assumed pseudo-parameter values — Ticket 2.2), and
[ADR 0004](adr/0004-import-side-candidate-stack-name-matching.md)
(import-side candidate stack-name matching — Ticket 2.3) — why these are
shaped the way they are. This document is the "how it works" companion;
the ADRs are the "why," same split as `parser-architecture.md`/ADR 0001.

## Pipeline overview

```
AstNode (one template, from Sprint 1's loadTemplate)
     │
     ▼
buildGraph(file, template)             graph/model.ts — Ticket 2.1
  │
  ├─ buildResolutionContext(template)    reused directly from Sprint 1
  ├─ evaluateConditions(template, ctx)   reused directly from Sprint 1
  │
  ├─ for each Resources.<LogicalId>:
  │    │
  │    ├─ resolveValue(Properties, ctx) → properties: ResolvedValue
  │    │     walked by extractReferenceEdges() for resourceRef/
  │    │     attributeRef leaves → 'reference' edges, one per
  │    │     occurrence (not collapsed), tagged with propertyPath + via
  │    │
  │    ├─ resourceInclusion(node, conditions) → inclusion
  │    │     never omits the node — excluded/unknown resources still
  │    │     get a GraphNode, per PO Question 1
  │    │
  │    └─ DependsOn attribute (raw, not resolveValue'd)
  │          extractDependsOnEdges() validates each target against
  │          context.resources directly → 'dependsOn' edges, or a
  │          GraphWarning per undeclared target
  │
  ▼
GraphModel { nodes, edges, warnings }
```

## Module map

| Module | Responsibility |
|---|---|
| `graph/model.ts` | `AstNode` (one template) → `GraphModel`; `nodeId()`, `buildGraph()` |
| `common/types.ts` | `GraphNodeId`, `GraphEdge` (discriminated: `reference` \| `dependsOn` \| `crossStackImport`) |
| `common/interfaces.ts` | `GraphNode`, `GraphWarning`, `GraphModel` |

## Node identity

`nodeId(file, logicalId)` → `` `${file}#${logicalId}` ``. This is the
*only* place a node identity is constructed — every edge's `source`/
`target` and every node's `id` go through it, so there's no second formula
that could silently disagree. See ADR 0002 for why this is `file`+
`logicalId`, never `logicalId` alone (PO Question 4d).

## `GraphNode` fields

| Field | Source |
|---|---|
| `id` | `nodeId(file, logicalId)` |
| `logicalId` | The `Resources.<LogicalId>` key |
| `type` | The resource's `Type`, if a literal string |
| `file` | The template's own file path — doubles as origin stack (see ADR 0002) |
| `pos` | Source position of the resource's own declaration (`Resources.<LogicalId>`'s node position) |
| `properties` | `resolveValue(Properties, context)`, or `undefined` if the resource has no `Properties` block |
| `inclusion` | `resourceInclusion()`, reused unchanged from Sprint 1 — `included`/`excluded`/`unknown` |

## Edge extraction

### `reference` edges — `extractReferenceEdges()`

Recursively walks a resolved `Properties` value tree. At each
`resourceRef`/`attributeRef` leaf, emits one edge carrying:

- `propertyPath: string[]` — the path from `Properties` to that leaf, e.g.
  `['VPCZoneIdentifier', '0']` for the first item of that list property.
  Not prefixed with `'Properties'` itself, since `reference` edges only
  ever originate there (Ticket 2.1 scope).
- `via` — `{kind: 'ref'}` for a `Ref`, or `{kind: 'getAtt', attribute}` for
  a `Fn::GetAtt`, so the two are never conflated into one undifferentiated
  "points at X" edge.

Recurses into `list` and `object` `ResolvedValue` kinds (structural
pass-through from `Fn::Join`/`Fn::Sub`/plain nesting); treats every other
kind — `scalar`, `parameterRef`, `pseudoParameterRef`, `unresolved`, and
**`importValueRef`** — as a leaf that produces no edge. The `importValueRef`
exclusion is deliberate, not an oversight: see ADR 0002 for why a `Ref`
inside an `Fn::ImportValue`'s export-name expression is a cross-stack
lookup key, not a same-template dependency.

### `dependsOn` edges — `extractDependsOnEdges()`

Reads the resource's raw `DependsOn` attribute directly (`findEntry`, not
`resolveValue` — `DependsOn` is never an intrinsic call, always a bare
logical-ID string or array of strings per CFN's spec, confirmed against
`internal-docs/cfn-ug.md`). Accepts both forms. Each named target is
checked against `context.resources` directly:

- Declared → one `dependsOn` edge.
- Not declared → one `GraphWarning` (`{file, logicalId, message}`), no
  edge fabricated.
- Any other shape (not a string, not an array of strings) → one
  `GraphWarning`, no edges from that attribute at all.

A `DependsOn` array with both valid and invalid entries produces edges for
the valid ones *and* a warning for the invalid one — one bad entry doesn't
suppress the others. Same-target entries listed more than once are not
collapsed, mirroring `reference` edges' non-collapsing behavior.

### What's never walked for edges

- **`Metadata`** — confirmed via direct fixture inspection (not assumed)
  that real templates' `Metadata` blocks don't contain genuine intrinsic
  usage worth tracking as a graph edge. See ADR 0002.
- **`Fn::GetStackOutput`** — recognized by `intrinsics.ts` as an explicit
  `unresolved` result (PO Question 4e) rather than silently falling through
  as an opaque object, but produces no edge — full support is a tracked
  follow-up, not implemented in Sprint 2. See `LIMITATIONS.md`.

## Testing approach

`src/graph/__test__/model.test.ts` — organized in four groups:

1. **Node construction** — one node per declared resource; correct `id`/
   `type`/`file`/`pos`/`properties`; a resource with no `Properties` still
   gets a node with `properties: undefined`; all three `inclusion` outcomes
   (`included`/`excluded`/`unknown`) still produce a node.
2. **`reference` edges** — `Ref`, `Fn::GetAtt` (with attribute), duplicate-
   target non-collapsing, a `Ref` nested inside `Fn::Join`, and the
   `Fn::ImportValue` exclusion case.
3. **`dependsOn` edges** — scalar form, array form, duplicate-target non-
   collapsing, an invalid target (warning, no edge), mixed valid/invalid in
   one array, and a malformed (non-string/array) attribute.
4. **Cross-file node identity (PO Question 4d)** — two unrelated fixture
   files declaring the same logical ID produce two distinct node IDs.
5. **Real-world fixtures** — `buildGraph()` run against `01-simple-lambda`,
   `02-complex-vpc-nat`, `03-multi-stack-ecs-fargate/network-stack`, all
   three `06-nested-stack-quickstart` templates, and
   `11-large-production-wordpress-ha`, plus an invariant check across all
   of them: no duplicate node IDs, and no `reference`/`dependsOn` edge
   targets a node ID that doesn't exist in the same graph.

**Mutation-tested, not just happy-path.** Two of the design decisions above
were verified to actually matter by deliberately breaking them and
confirming the test suite catches it, then reverting:

- Making `extractReferenceEdges()` recurse into `importValueRef.exportName`
  — confirmed this makes the "does NOT produce a reference edge" test fail.
- Deduplicating `DependsOn` targets via a `Set` before emitting edges —
  confirmed this makes the "not collapsed" test fail.

Both mutations were caught, confirming those tests exercise real behavior
rather than being vacuously true.

## Ticket 2.2: the export symbol table

**Module:** `graph/exports.ts`. **Entry point:**

```ts
const table = buildExportSymbolTable(loadedTemplates); // LoadedTemplate[], N templates at once
```

Indexes every `Outputs.*` entry that has an `Export.Name`, across however
many templates are passed in one call, into `table.byName: Map<matchKey,
ExportTableEntry>` — ready for Ticket 2.3 to match against a resolved
`importValueRef.exportName`. Outputs with no `Export` block at all aren't
this table's concern (they're not usable for cross-stack referencing
regardless) and are simply skipped, no warning.

### Why export names need a second resolution pass

Real fixtures showed every multi-file example's export names are built
from `AWS::StackName` (often combined with `AWS::Region`) — a pseudo
parameter, always deploy-time-unknown, which Sprint 1's `resolveValue()`
correctly never guesses. Left as-is, none of these export names would ever
collapse to a literal string, and the symbol table would have nothing to
match against.

So `buildExportSymbolTable()` resolves each `Export.Name` **twice**: once
with Sprint 1's ordinary context (to detect, via `containsPseudoParameterRef`,
whether the name depends on any `AWS::*` pseudo parameter at all), and —
only if it does — again with a second context that has
`assumedPseudoParameters` populated (`AWS::StackName` → `assumedStackName
(file)`; every other `AWS::*` name → one fixed placeholder — see
[ADR 0003](adr/0003-export-symbol-table-assumed-values.md) for why these
two need different rules). This reuses `Fn::Join`/`Fn::Sub`'s existing
collapse-to-literal logic in `intrinsics.ts` unchanged — no export-name-specific
re-implementation of either — since a `Ref` to `AWS::StackName` now simply
resolves to a literal scalar instead of a `pseudoParameterRef`, which is
exactly what makes `.every(isScalarResolved)` collapse the whole
expression the same way it would for any other fully-static value.

Every entry the assumption touched carries `usedAssumedPseudoParameters:
true` — never silently indistinguishable from an export name that was
already a plain literal to begin with.

### What still doesn't resolve, on purpose

- **A regular `Parameters` entry with no `Default`** used inside an export
  name (e.g. `01-simple-lambda`'s `${EnvName}`) is NOT covered by the
  pseudo-parameter assumption — that's PO Question 2's "no `--parameters`
  file, never guess" precedent, unchanged. Reported via
  `unresolvableExportName`, reason names the specific parameter.
- **`AWS::NoValue`/`AWS::NotificationARNs`** inside an export name are
  deliberately not given placeholder values (nonsensical for a
  property-removal or list-typed pseudo parameter to stand in for part of
  a string) — also `unresolvableExportName`.
- **An `Export` block with no `Name` at all** (malformed) — also
  `unresolvableExportName`, reason `"Export block has no Name"`.

### Output-level `Condition`, reused unchanged

An `Outputs.*` entry can carry its own `Condition` attribute exactly like
a resource can (confirmed real usage: `06-nested-stack-quickstart`'s
`EIP1`–`EIP4` outputs, each gated by a different bastion-count condition).
`resourceInclusion()` — Sprint 1's function, name aside — is reused
completely unchanged: it only ever looks for a `Condition` key on whatever
node it's given, so an `Outputs` entry works exactly like a `Resources`
entry here. `excluded` outputs get no table entry at all (they provably
won't exist); `unknown` ones still get an entry (mirroring PO Question 1's
"never silently guess resource existence," applied here to outputs) so a
real `Fn::ImportValue` referencing one can still be matched, carrying
`inclusion: {kind: 'unknown', reason}` for downstream visibility.

### Duplicate export names: removed from the table, not merged

Per PO Question 4c: if 2+ entries (same template or different templates —
both are checked, and checked in both input orders to rule out a "first
wins" or "last wins" bug) resolve to the same `matchKey`, neither is placed
in `byName` — both are pulled out and reported as one `duplicateExportName`
warning naming every occurrence. Verified against the real fixture pair the
ticket names: `01-simple-lambda` and
`05-malformed-and-missing-ref/missing-resource-ref.yaml` both export the
literal name `LambdaRole`.

### Testing approach

`src/graph/__test__/exports.test.ts` — basic indexing, the assumed-pseudo-
parameter cases (`AWS::StackName` alone, `AWS::Region`+`AWS::StackName`
combined, the `EnvName`-parameter non-assumption case), Output-level
inclusion (`excluded`/`unknown`), duplicate-name conflicts (within one
template, across two templates, and order-independence), 6 real-fixture
cases, and a closing invariant test across every `examples/` fixture that
has an `Outputs` section at all — confirming no crash and internally
consistent results project-wide, not just on the fixtures the ticket
happened to name.

**Mutation-tested:** the duplicate-conflict grouping (replaced with
unconditional last-wins insertion — 4 tests caught it) and the
`usedAssumedPseudoParameters` short-circuit (replaced with "always resolve
with the assumed context" — 3 tests caught it), both confirmed and
reverted, same discipline as Ticket 2.1's mutation checks.

## Ticket 2.3: cross-stack `Fn::ImportValue` resolution

**Module:** `graph/merge.ts`. **Entry point:**

```ts
const graph = mergeGraphs(loadedTemplates); // LoadedTemplate[], N templates at once -> one GraphModel
```

Combines every template's own `buildGraph()` output (nodes, `reference`/
`dependsOn` edges, warnings — unchanged from Ticket 2.1) with new
`crossStackImport` edges, resolved by matching each `Fn::ImportValue` call
against Ticket 2.2's export symbol table.

### Why this needs the raw AST, not `importValueRef`

Sprint 1's `resolveValue()` already tags `Fn::ImportValue` calls as
`{kind: 'importValueRef', exportName}` — but `exportName` there is already
collapsed using ordinary parameter `Default`s, with no way to tell after
the fact which parts came from a parameter that might need a different
substitution. Real-fixture testing (`examples/03-multi-stack-ecs-fargate`)
showed this matters: matching sometimes needs to re-resolve the *same* raw
export-name expression multiple times with different substitutions (see
below). So `merge.ts` has its own small raw-AST scanner,
`findImportValueCalls()`, that finds `Fn::ImportValue` call sites
structurally (mirroring `resolveValue()`'s own single-key-object dispatch
check, but without resolving anything) and hands back the *raw* argument
node for `resolveImportCall()` to resolve as many times as needed.

### Three-strategy matching, weakest last

`resolveImportCall()` tries, in order — full detail and the real-fixture
discovery behind step 3 in [ADR 0004](adr/0004-import-side-candidate-stack-name-matching.md):

1. **Exact** — ordinary resolution already matches a real export.
2. **Assumed pseudo parameter** (PO 4b) — only retried if the exact
   resolution depended on an `AWS::*` pseudo parameter.
3. **Assumed candidate stack name** (PO 4f) — only reached if 1 and 2 both
   failed; retries once per *other* template being merged, forcing every
   `Parameters` reference in the expression to that template's own
   `assumedStackName()`. Exactly one candidate matching is accepted;
   zero or 2+ distinct matches stays ambiguous.

Every successful match's edge carries `matchedVia`, naming which strategy
found it — never silently presented as equally certain as an exact match.

### Finding the target resource

Once an export name matches an `ExportTableEntry`, that entry's `value`
(the Output's resolved `Value`) is walked with the same shared
`walkResolvedValueLeaves()` Ticket 2.1's `reference`-edge extraction uses,
looking for `resourceRef`/`attributeRef` leaves — one `crossStackImport`
edge per leaf found, not collapsed (same non-collapsing stance as
`reference` edges). A matched export whose `Value` is a plain literal
(e.g. a hardcoded string) produces **no edge at all** — the name matched,
but there's no specific resource to point at — and this is not treated as
a warning, mirroring how a literal `Properties` value produces no
`reference` edge either.

### Unresolved imports: flagged, run still succeeds (PO Question 4)

Every failure path produces a `GraphWarning` (`kind: 'unresolvedImport'`)
with a distinguishable message — export name not statically determinable,
matched a name already flagged as an ambiguous cross-template duplicate
(PO 4c), matched two different exports under different PO 4f candidates,
or matched no export in any provided template at all. `mergeGraphs()`
never throws for this; the graph is returned complete with whatever did
resolve.

### Testing approach

`src/graph/__test__/merge.test.ts` — a synthetic 3-template fixture set
(`merge-exporter-one/two.yaml`, `merge-consumer.yaml`) covering each
matching strategy individually, the ambiguous-candidate case, the
duplicate-export-name case, and the plain-literal-Value-produces-no-edge
case; plus the two real fixtures the ticket names —
`examples/03-multi-stack-ecs-fargate` (network-stack + service-stack,
confirming every one of service-stack's 7 imports resolves via
`assumedCandidateStackName` with zero warnings) and
`examples/04-unresolved-import` (confirming every import is genuinely
unresolvable with no sibling template available, and that the run
completes rather than throwing).

**Mutation-tested:** the ambiguous-candidate check (relaxed to accept the
first candidate match unconditionally — caught) and the literal-Value
no-edge rule (forced to emit an edge for a scalar leaf — caught), both
confirmed and reverted.

## Ticket 2.4: multi-template pipeline orchestration

**Module:** `src/cli.ts`. **Entry point:** `npm run demo -- "<glob>"` (or no
arguments, defaulting to `examples/03-multi-stack-ecs-fargate/*/template.yaml`).

Wires everything above into one runnable path: a glob of file paths on disk
→ `loadTemplates()` (Sprint 1, skip-and-warn) → `mergeGraphs()` (Ticket
2.3) → a printed summary. Two small pieces of orchestration logic are
exported from `cli.ts` itself and unit-tested directly
(`src/__test__/cli.test.ts`), rather than only being exercised indirectly
through the CLI's stdout:

- **`resolveInputFiles(patterns)`** — expands N glob patterns (or literal
  paths — indistinguishable to the `glob` package) into one de-duplicated,
  sorted file list. Normalizes backslashes to forward slashes before
  calling `glob()` — confirmed directly (not assumed) that an unmodified
  Windows absolute path (`fileURLToPath()`'s own output) silently matches
  *nothing*, since `glob` treats `\` as its escape character, the same as
  standard shell glob syntax. This normalization is correct on every
  platform, not a Windows-only special case, since forward slashes work as
  path separators on Windows regardless of source.
- **`summarize(graph, loadWarnings)`** — renders the merged `GraphModel`
  as: template/node/edge counts (edges broken down by kind), every
  resolved `crossStackImport` edge (source → target, export name,
  `matchedVia`), every `unresolvedImport`/`dependsOnTargetInvalid` warning,
  and every file-load warning — matching Sprint 2's own "Demo Scenario"
  wording (`internal-docs/SPRINT-PLAN.md`) almost verbatim: "node count,
  edge count, list of resolved and unresolved cross-stack references."

`main()` itself only runs when `cli.ts` is executed directly (`node
cli.js ...`), guarded by comparing `import.meta.url` against
`process.argv[1]` — otherwise importing `resolveInputFiles`/`summarize`
for testing would trigger a real glob expansion and merge run as a side
effect of loading the module, printing to stderr and potentially exiting
non-zero from inside a test file. Caught directly (not assumed) when the
first version of `cli.test.ts` printed `"No template files matched"` to
stderr despite never calling `main()`.

### Integration testing

Beyond `cli.test.ts`'s own unit tests, `graph/__test__/merge.test.ts` has a
dedicated Ticket 2.4 integration suite against the full, realistic
3-template `examples/03-multi-stack-ecs-fargate` trio (network-stack +
both of its service-stack siblings) — the "3+ templates, cross-referencing"
fixture the ticket's testing requirement names. Node and non-cross-stack
edge counts are asserted against an independently-computed sum (each
template's own `buildGraph()` result), not a hardcoded magic number, so the
test would actually fail if merging ever dropped or duplicated a
per-template node/edge. Running this for real also corrected an initial
wrong assumption: `private-subnet-public-service` resolves only 5 of its 7
imports against this particular `network-stack` (a "public VPC" with no
private subnets) — genuinely unresolvable, not a bug, exactly matching
that fixture trio's own `SOURCE.md` note that it shares only *some* exports
with its siblings.

## Architecture review: `GraphModel` schema extensibility for Sprints 6, 7, 11

Sprint 2's own plan calls for confirming, before closing the sprint, that
the `GraphModel` schema holds up against Sprints 6 (search), 7 (blast
radius), and 11 (diff)'s stated needs — the same kind of review Sprint 1
did for the resolver before Sprint 2 started (see
`parser-architecture.md`'s equivalent section). This is that review's
record: what was checked, against each sprint's actual ticket text (not
assumed), and what it found.

**Exhaustiveness check.** Every place in `graph/*.ts` and `cli.ts` that
pattern-matches a `GraphEdge`/`GraphWarning`/`ResolvedValue`'s `kind` (27
occurrences, grepped directly) checks only the specific kind it cares
about — none is an exhaustive `switch`. Concretely verified: `cli.ts`'s
`summarize()` groups edges into a `Map<string, number>` keyed by
`edge.kind` dynamically, so a brand-new edge kind shows up in the printed
summary automatically, with zero code changes. This means adding a new
edge kind (`network`, `iam` — both explicitly anticipated by ADR 0002) is
purely additive, the same guarantee Sprint 1 confirmed for `ResolvedValue`.

**Sprint 7 (blast radius) — Tickets 7.1/7.2 need forward and reverse
traversal over `graph.edges`, filtering by `source`/`target` respectively,
with an N-hop depth limit.** `GraphEdge`'s `source`/`target` fields already
support both directions directly — traversal is a BFS/DFS the rendering
layer builds on top of the existing array, not something the schema itself
needs additional fields for. The sprint's own risk note ("Low — this is a
well-understood graph algorithm problem *once the schema (Sprint 2) is
solid*") is conditioned on exactly this, and it holds.

**Sprint 6 (search) — the query engine is explicitly required to "reuse
the same edge-type model from Sprint 2 rather than building a parallel
data structure."** Since `GraphModel` is a plain exported data structure
(not hidden behind an opaque internal API), any future module can import
and traverse `graph.nodes`/`graph.edges` directly. Whether relationship
keywords like "exposed to"/"can access" (PRD examples) map onto *existing*
edge kinds or need a new one (e.g. a future `network` kind covering
security-group/routing reachability) is Sprint 6/9's own design question,
not something Sprint 2 needs to pre-decide — the schema doesn't block
either answer.

**Sprint 11 (diff) — Ticket 11.1 requires "two independent, correct graphs
... with no cross-contamination between them."** Verified two ways:
statically (grepped `graph/*.ts` and `parser/*.ts` for module-level
mutable state — `buildGraph()`, `buildExportSymbolTable()`, and
`mergeGraphs()` are all pure functions, no `let`/cache/singleton anywhere)
and behaviorally (ran `mergeGraphs()` on template set A, then set B, then A
again — A's second result was byte-identical to its first, and neither
graph's nodes leaked into the other's). One real caveat for whoever picks
up Ticket 11.2 (still blocked on PO Question 10): `GraphNode.id` includes
the *file path* it came from, and diffing "old" vs "new" almost certainly
means two different directories/paths for what's conceptually "the same"
template — so cross-version node matching will need its own key (e.g.
strip a common directory prefix, then match on the remainder + logical
ID), not `node.id` equality directly. This isn't a schema gap — `file` is
a plain string, and Ticket 11.2 is free to derive whatever comparison key
it needs from it — but it's exactly the kind of thing worth flagging now
rather than letting Ticket 11.2 discover it mid-implementation.

**Conclusion: the schema holds.** No code changes came out of this
review, same as Sprint 1's — extending `GraphEdge`/`GraphWarning` when a
later sprint needs to is expected and normal, and the one real caveat
found (diff's cross-version matching) is already correctly scoped as
Ticket 11.2's own concern, already flagged as blocked on PO Question 10 in
the sprint plan, not a Sprint 2 gap.

## Related documents

- [ADR 0002: Graph node identity and edge model](adr/0002-graph-node-identity-and-edge-model.md)
- [ADR 0003: Export symbol table — assumed values](adr/0003-export-symbol-table-assumed-values.md)
- [ADR 0004: Import-side candidate stack-name matching](adr/0004-import-side-candidate-stack-name-matching.md)
- [`LIMITATIONS.md`](../LIMITATIONS.md) — current, authoritative gaps list
- [`docs/parser-architecture.md`](parser-architecture.md) — Sprint 1's
  pipeline this one builds directly on top of
- [`docs/developer-guide.md`](developer-guide.md) — project-wide doc index
