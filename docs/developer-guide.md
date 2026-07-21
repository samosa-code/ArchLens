# Developer Guide

Index of ArchLens's internals, one entry per module or module group, added
as each is built. Each entry is a short summary — the real depth lives in
its own linked doc, so this file stays a map, not something that itself
grows unwieldy across sprints.

## Parser (Sprint 1)

Loads CloudFormation template files from disk, resolves their intrinsic
functions (`Ref`, `Fn::GetAtt`, `Fn::Join`, `Fn::Select`, `Fn::Sub`,
`Fn::FindInMap`, `Fn::ImportValue` (stub), `Fn::If`) to arbitrary nesting
depth, and evaluates the `Conditions` block to determine per-resource
inclusion — all statically, from the template files alone, per the
project's static-analysis-only scope.

**Modules:** `src/parser/loader.ts`, `src/parser/intrinsics.ts`,
`src/parser/conditions.ts`, `src/parser/getAttShorthand.ts`

**Full detail:** [`docs/parser-architecture.md`](parser-architecture.md) —
pipeline overview, per-function behavior, and the design principles that
recur across every stage (never silently guess; keep partial information
rather than giving up; validate against real templates, not only
synthetic fixtures).

**Related:** [ADR 0001](adr/0001-yaml-json-parser-choice.md) (parser
library choice) · [`LIMITATIONS.md`](../LIMITATIONS.md) (current gaps)

---

## Graph model (Sprint 2, Ticket 2.1)

Builds a `GraphModel` (nodes + edges + warnings) from one already-parsed
template — one node per declared resource, `reference` edges from
`Ref`/`Fn::GetAtt` inside `Properties`, `dependsOn` edges from the
`DependsOn` attribute. Multi-template merge (cross-stack `Fn::ImportValue`
resolution) is Ticket 2.3, not yet built.

**Modules:** `src/graph/model.ts`

**Full detail:** [`docs/graph-architecture.md`](graph-architecture.md) —
pipeline overview, node/edge field reference, and why `Metadata` and
`Fn::ImportValue`'s export-name expression are deliberately never walked
for edges.

**Related:** [ADR 0002](adr/0002-graph-node-identity-and-edge-model.md)
(node identity, edge model design) · [`LIMITATIONS.md`](../LIMITATIONS.md)
(current gaps, including `Fn::GetStackOutput`)

## Export symbol table (Sprint 2, Ticket 2.2)

Indexes every `Outputs.*` entry with an `Export.Name` across N templates
into a `matchKey -> entry` lookup, ready for Ticket 2.3 to match against a
resolved `importValueRef.exportName`. Resolves each export name against
both Sprint 1's ordinary context and a second context with assumed
pseudo-parameter values (`AWS::StackName` → derived per-file;
`AWS::Region`/`AWS::AccountId`/`AWS::Partition`/`AWS::URLSuffix`/
`AWS::StackId` → one fixed placeholder each), since real fixtures showed
every multi-stack export name depends on at least `AWS::StackName`. Every
assumption is surfaced via `usedAssumedPseudoParameters`, never silently
treated as deployed truth. Duplicate export names (PO Question 4c) are
removed from the lookup and reported as a conflict instead of resolved via
last-wins.

**Modules:** `src/graph/exports.ts`, `src/graph/stackName.ts`

**Full detail:** [`docs/graph-architecture.md`](graph-architecture.md#ticket-22-the-export-symbol-table)
— the two-pass resolution mechanism, what stays deliberately unresolved
(parameter-dependent names, malformed `Export` blocks), and Output-level
`Condition` handling.

**Related:** [ADR 0003](adr/0003-export-symbol-table-assumed-values.md)
(assumed stack name and pseudo-parameter matching strategy) ·
[`LIMITATIONS.md`](../LIMITATIONS.md)

## Cross-stack merge (Sprint 2, Ticket 2.3)

Combines N templates' `buildGraph()` output with `buildExportSymbolTable()`
into one merged `GraphModel`, resolving each `Fn::ImportValue` call into a
`crossStackImport` edge. Tries exact matching, then PO 4b's assumed
pseudo-parameter substitution, then — a real-fixture-driven discovery, PO
Question 4f — retrying with each sibling template's own assumed stack name
substituted for any regular `Parameters` reference used to name the
exporting stack (needed for `examples/03-multi-stack-ecs-fargate`'s own
import pattern). An import that can't be matched anywhere is flagged via a
`GraphWarning`, never silently dropped — the merge still succeeds with a
partial graph (PO Question 4).

**Modules:** `src/graph/merge.ts`

**Full detail:** [`docs/graph-architecture.md`](graph-architecture.md#ticket-23-cross-stack-fnimportvalue-resolution)
— the three-strategy matching order, how the target resource is found from
an export's `Value`, and why a literal-valued export produces no edge.

**Related:** [ADR 0004](adr/0004-import-side-candidate-stack-name-matching.md)
(candidate stack-name matching) · [`LIMITATIONS.md`](../LIMITATIONS.md)

## Pipeline orchestration / demo CLI (Sprint 2, Ticket 2.4)

Wires a glob of template files on disk through `loadTemplates()` →
`mergeGraphs()` → a printed summary (node/edge counts, resolved and
unresolved cross-stack references). `npm run demo -- "<glob>"` runs it;
`npm run demo` alone defaults to the 3-template
`examples/03-multi-stack-ecs-fargate` fixture. Still the Sprint 1/2 data
layer only — no `--out` flag, no HTML rendering (Sprint 3, Ticket 3.4,
builds the real product CLI on top of this same file).

**Modules:** `src/cli.ts`

**Full detail:** [`docs/graph-architecture.md`](graph-architecture.md#ticket-24-multi-template-pipeline-orchestration)
— the glob-normalization bug this ticket caught and fixed, and how the
integration test independently verifies node/edge counts rather than
hardcoding them.

**Related:** [README: "How multi-stack merging works"](../README.md) ·
[`LIMITATIONS.md`](../LIMITATIONS.md)

---

*(Later sprints' search, blast radius, diff, rendering get their own
entries here as they're built.)*
