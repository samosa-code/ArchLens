# Known Limitations

Started in Sprint 1 (Ticket 1.5) and grown ticket by ticket since — see
[`docs/parser-architecture.md`](docs/parser-architecture.md) for the
implementation detail behind each of these. Per the sprint plan
(Ticket 14.3), this file is the authoritative consolidated list;
individual module docs may restate an entry but this file is the one to
keep current.

## Condition resolution (Ticket 1.5)

- **No `--parameters` file in v1** (PO Question 2). A `Conditions` block
  entry that depends on a parameter with no `Default` — or on an `AWS::*`
  pseudo parameter, which is always deploy-time-only — cannot be
  statically evaluated. It resolves to `unknown`, never guessed as `true`
  or `false`.
- **Resources gated by an `unknown` condition are flagged, never silently
  included or omitted** (PO Question 1). `parser/conditions.ts`'s
  `resourceInclusion()` returns a distinct `{kind: 'unknown', reason}` for
  these — it is the caller's job (eventually the graph/render layer) to
  surface that visibly rather than default to one behavior.
- **`Fn::And`/`Fn::Or` use correct three-valued short-circuit logic**, not
  a limitation but worth stating precisely: `Fn::And` with one
  definitively-`false` operand is `false` even if another operand is
  `unknown` (and symmetrically for `Fn::Or` with a `true` operand). Only
  when no operand is decisive does the result become `unknown`.
- **Circular condition references** (`A` referencing `B` referencing `A`
  via `{Condition: "Name"}`) resolve to `unknown` with a
  "circular reference" reason rather than infinite-looping. This is a
  template-authoring error CloudFormation itself would also reject at
  deploy time; we degrade gracefully rather than crash.
- **`Fn::If` (property-level) mirrors the same stance**: if its condition
  isn't statically `true` or `false`, it resolves to `unresolved` rather
  than guessing a branch. Implemented as part of this ticket alongside
  resource-level condition evaluation, since both need the same evaluator.

## Malformed template handling (Ticket 1.6)

- **Skip-and-warn, not fail-fast** (PO Question 3). `loader.ts`'s
  `loadTemplates()` loads each file in a multi-file run independently; a
  file that fails to parse (invalid YAML syntax, non-strict JSON) is
  recorded as a warning (`{file, message}`) and excluded from the result,
  while every other file still loads and is returned. `loadTemplates()`
  itself never throws.
- **A single `loadTemplate()` call still throws.** Skip-and-warn is a
  multi-file orchestration behavior, not a property of the loader itself
  — calling `loadTemplate()` directly on one malformed file raises, same
  as always. Only `loadTemplates()` (plural) catches per-file failures.
- **Semantically-broken-but-syntactically-valid content is not a load
  failure.** A file with a dangling `Fn::GetAtt`/`Ref` loads successfully
  under `loadTemplates()` — that's `intrinsics.ts`'s `unresolved` result
  on the specific property, not a warning at the loading stage. The two
  failure modes are deliberately different: one is "this file couldn't be
  read at all," the other is "this file read fine but makes a claim about
  the template that isn't true."

## Parser scope (Tickets 1.1–1.6)

- **YAML anchors/aliases** (`&anchor` / `*ref`) are not supported by the
  loader — a template using them fails at the loading stage with an
  explicit error, before any resolution is attempted. See
  [ADR 0001](docs/adr/0001-yaml-json-parser-choice.md).
- **`AWS::NoValue`** is resolved like any other pseudo parameter
  (`pseudoParameterRef`). Its special "remove this property from the
  parent" semantic is a property-application concern, not implemented yet.
- **`Fn::ImportValue` never resolves an actual cross-stack value** — only
  tags the call with its export-name expression resolved as far as
  possible. Matching it against another template's `Export.Name` needs the
  multi-stack merge Sprint 2 builds.
- **Intrinsics with no resolver at all yet**: `Fn::Base64`, `Fn::Cidr`,
  `Fn::Transform`, and the newer `Fn::ForEach` template language extension.
  None are required by any Sprint 1 ticket. Property values using them pass
  through structurally unchanged (nested intrinsics inside them still
  resolve) rather than erroring. (`Fn::GetAZs` and `Fn::Split` *were* in
  this list — see below; both were added after a real-world stress test
  against 67 diverse fetched templates showed `Fn::GetAZs` used in 13 of
  them, almost always as `!Select [N, !GetAZs region]` for pinning a
  resource to "the Nth Availability Zone.")
- **`Fn::GetAZs` never resolves to actual AZ names** — always deploy-time
  *and* AWS-account-specific (which zones are enabled differs per
  account), so it resolves to a distinct `availabilityZonesRef` (region
  tagged, not guessed), the same "recognized but never guessed" stance as
  `pseudoParameterRef`. `Fn::Select` over one resolves to an
  `availabilityZoneRef` (region + a known static index) rather than
  `unresolved`, since the *position* is genuinely known even though the
  actual zone name isn't.
- **`Fn::Split` computes a real split when both its delimiter and source
  string are literal** (unlike `Fn::GetAZs`, this is a pure string
  operation with no deploy-time-only component) — resolves to `unresolved`
  if either argument isn't statically determinable, most commonly because
  the source is a parameter with no `Default` (a real fixture pattern:
  `examples/14-diverse-corpus/quickstart-vpc-large.yaml` parses several
  `"key=value"`-formatted tag parameters this way — correctly stays
  unresolved there, since those specific parameters have no `Default`).
- **`Fn::GetStackOutput` is recognized but never resolved** (PO Question
  4e, surfaced during Sprint 2 Ticket 2.1's documentation research). Unlike
  the intrinsics above, it's explicitly flagged — `resolveValue()` returns
  `{kind: 'unresolved', reason: 'Fn::GetStackOutput is not yet supported'}`
  rather than silently passing it through as an opaque object — since it
  represents a real cross-account/cross-Region stack-output reference, not
  an inert value. Not used by any `examples/` fixture; the available
  CloudFormation User Guide document never states its actual argument
  syntax (only cross-references a separate Template Reference Guide this
  project doesn't have), so implementing full resolution now would mean
  guessing at unconfirmed syntax. Tracked as a follow-up ticket.

## Graph model (Sprint 2, Ticket 2.1)

- **`buildGraph()` itself is still single-template only** — it builds a
  `GraphModel` from one template; `graph/merge.ts`'s `mergeGraphs()`
  (Ticket 2.3) is what combines N templates' `buildGraph()` results and
  resolves `Fn::ImportValue` against another template's `Export.Name` into
  `crossStackImport` edges. Both are now built (Tickets 2.1–2.4 complete)
  — this split is an internal layering, not a gap.
- **`Fn::GetStackOutput` produces no edge**, for the same reason it's
  unresolved in the parser (see above) — there is currently no way to
  represent this reference in the graph at all, not even as a flagged
  warning. A template that relies on it will show that resource's property
  as `unresolved`, but the graph itself won't surface a distinct
  "cross-stack reference exists but isn't modeled" signal beyond that.
- **`Metadata` is never walked for graph edges**, even though it's a valid
  place to put arbitrary structured data (including, in principle,
  intrinsics). Confirmed via direct fixture inspection that real templates'
  `Metadata` usage is non-referential (linter/build-tool annotations); see
  ADR 0002 for the full reasoning.

## Export symbol table (Sprint 2, Ticket 2.2)

- **A plain `Parameters` entry with no `Default` inside an export name is
  never assumed** (e.g. `01-simple-lambda`'s `${EnvName}`) — only `AWS::*`
  pseudo parameters get the assumed-value treatment (PO Question 4b). This
  export name stays permanently unresolvable in v1, consistent with PO
  Question 2 (no `--parameters` file).
- **`AWS::NoValue`/`AWS::NotificationARNs` inside an export name are never
  assumed** — a placeholder string wouldn't be meaningful for a
  property-removal or list-typed pseudo parameter. An export name using
  either stays unresolvable.
- **The assumed-pseudo-parameter substitution only applies to
  `Export.Name` resolution, never to an Output's `Value`.** A `Value`
  expression that itself uses `AWS::Region` etc. still resolves via
  Sprint 1's ordinary (never-guess) behavior — `pseudoParameterRef`, not a
  literal. See ADR 0003 for why this scope is deliberate, not an oversight.
- **`assumedStackName()`'s folder-vs-filename heuristic is a convention,
  not a guarantee.** It's verified against every real multi-file
  `examples/` layout available, but a project structure organized
  differently from both (e.g. deeply nested folders where neither the
  immediate filename nor the immediate parent folder is distinctive) could
  still produce a collision. Any such collision surfaces as a
  `duplicateExportName` conflict (never silently merged), so the failure
  mode is "flagged ambiguity," not "wrong answer accepted as right."

## Cross-stack import resolution (Sprint 2, Ticket 2.3)

- **PO Question 4f's candidate-stack-name substitution forces *every*
  `Parameters` reference in an import's export-name expression to the same
  candidate value**, without identifying which specific parameter
  represents "the exporting stack's name." Every real fixture uses exactly
  one such parameter per import expression, so this is harmless in
  practice, but a template combining two genuinely different
  no-default-matching parameters in the same expression could in principle
  produce a coincidental false match. Always labeled
  `matchedVia: 'assumedCandidateStackName'` (the weakest match kind) so
  this is visible rather than silent — see ADR 0004.
- **`Fn::ImportValue` calls are found via a raw-AST structural scan
  (`findImportValueCalls()`), separate from Sprint 1's `resolveValue()`
  dispatch.** The two are kept in sync by both checking for the same
  single-key-object shape (`{"Fn::ImportValue": ...}`), but they are
  independent implementations — a future new `Fn::ImportValue` calling
  convention would need updating in both places.
- **A matched export whose `Value` doesn't resolve to a `resourceRef`/
  `attributeRef` (e.g. a hardcoded literal string) produces no graph edge
  at all**, even though the name genuinely matched — there's no distinct
  signal in the graph that "this import is satisfied but points at
  something that isn't a single resource," only the absence of an edge.
- **Nested-stack outputs (`AWS::CloudFormation::Stack` + `Fn::GetAtt` to a
  nested stack's `Outputs.*`, as used by `examples/06-nested-stack-quickstart`)
  are a completely different mechanism from `Export`/`Fn::ImportValue` and
  are not covered by this ticket at all** — they already resolve as an
  ordinary `attributeRef` `reference` edge (Ticket 2.1), since from the
  parent template's point of view a nested stack's outputs are just another
  resource attribute, not a cross-stack import.

## Real-world stress test (Sprint 2 wrap-up)

Before Sprint 3 (rendering) builds on top of the graph model, the full
parser + graph pipeline was run against 67 additional real, diverse
templates fetched specifically for this (`examples/14-diverse-corpus`,
provenance in its own `SOURCE.md`/`MANIFEST.tsv`) — spanning ~30 AWS
service areas, three source repositories, SAM/`Transform`-using templates,
`Fn::ForEach`, custom resources, StackSets, and one 1,765-line template —
well beyond what examples 01–13 exercise individually, specifically to
surface integration-level bugs before they'd be expensive to unwind.

**Result: zero crashes** across all 67 individually and merged together at
once (591 nodes, 731 edges, 1.8s). Two genuine gaps were found and fixed
as a direct result (see "Parser scope" above): `Fn::GetAZs` (used in 13 of
the 67 fixtures, previously unimplemented) and `Fn::Split` (its common
pairing with `Fn::Select`). Every remaining `unresolved` result across the
corpus was confirmed legitimate — genuinely dynamic `Fn::If`/
`Fn::FindInMap` operands, parameters with no `Default`, and two templates
(`gitea-solution.yaml`, `gitlab-server-solution.yaml`) with real dangling
references to a companion "network stack" template not included in this
fetch — not a single case traced back to a resolver bug.

Merging all 67 together (a realistic "point ArchLens at a big glob of
unrelated templates" scenario) also became the largest real confirmation
of PO Question 4d's node-identity design: 59 logical IDs are genuinely
reused across unrelated templates in this corpus (`InstanceSecurityGroup`
alone appears in 10 of them) — every one would have silently collapsed
into a single misleading node under logical-ID-only identity, and none
did, since node identity always includes the origin file. This is now a
permanent regression suite, not just a one-time pass —
`src/graph/__test__/diverseCorpus.test.ts`.

## Render layer (Sprint 3, Tickets 3.1–3.3)

- **Same-`logicalId` labels across a multi-stack merge are visually
  indistinguishable.** Two resources named `Service` in different
  templates (a real case: `examples/03-multi-stack-ecs-fargate`) render
  as two boxes both labeled "Service," with nothing in the diagram itself
  telling them apart (found during Sprint 3.5's Ticket A.11 eyeball test).
  Node identity is still correct internally (`${file}#${logicalId}`, PO
  Question 4d) — this is a display-only gap. Disambiguating the visible
  label on a collision is a scoped future ticket, not fixed yet.
- **Container nesting now renders as real, labeled, nested boundary
  rectangles (Ticket 3.6.1)** — `ArchitectureGraph`'s containers
  (VPC/Subnet/cluster/stack/account/region) and each node's `containerId`
  (carried through to `RenderGraph` since Ticket 3.3) are laid out via
  `@dagrejs/dagre`'s native compound-graph mode (`compound: true` +
  `setParent()`) and drawn as `.archlens-container` rects, behind every
  node/edge, sorted parent-before-child. See `docs/render-architecture.md`
  for the mechanism.
- **A real `@dagrejs/dagre` compound-mode limitation, worked around via a
  flat-layout fallback.** Certain moderate-scale compound graphs (confirmed
  directly: ~200 nodes / 20 containers with chain+hub edges) make dagre's
  own edge-routing throw `"Not possible to find intersection inside of the
  rectangle"` — confirmed not simply a scale problem (a 500-node case with
  the identical shape does not crash) and not reliably avoidable by tuning
  `ranker` or container minimum sizes. `computeLayout()` catches this and
  falls back to `layoutComponentFlatFallback()`: a non-compound dagre
  layout for real node positions, with each container's box then computed
  as the padded bounding-box union of its members/children. Nodes and
  containers still never overlap incorrectly under the fallback, but the
  fallback's boxes are a manual approximation rather than dagre's own
  compound-aware placement, so packing can look less tight than the
  primary path on an affected component.
- **"View source" in the detail panel is plain `file:line` text, not a
  clickable link.** A statically-exported, self-contained `index.html`
  (Ticket 3.1's whole premise) has nothing real to jump to — no editor
  integration, and browsers don't support `file://...#Lnn` anyway. A
  non-functional link that looks clickable would be worse than honest
  text.
- **Detail-panel security/cost findings depend on a rule engine that
  doesn't exist yet** (Sprint 9). The panel's finding callout and
  per-item warning tint are fully built and tested (synthetic fixtures,
  since `ArchNode.badges` is always empty from the real pipeline today),
  but nothing populates a real `Badge` until Sprint 9 lands.
- **Real service icons now render for 44 of the ~50 service keys
  `rules.ts` uses (Ticket 3.6.2)** — pulled from the official AWS
  Architecture Icons pack, inlined as `data:image/svg+xml;base64,...` URIs
  (never a runtime-fetched image `src`, so Ticket 3.1's one-file/
  zero-network invariant still holds). Coverage is intentionally partial,
  not a gap to silently patch over: `datapipeline` and `iotanalytics` have
  no matching icon in the current pack (both are legacy/deprecated AWS
  services no longer in AWS's own current icon set) and correctly fall
  back to the pre-existing plain-text subtitle — the same fallback every
  uncovered service already used before this ticket. See
  `docs/developer-guide.md`'s icon-asset section for the naming
  convention a contributor adding coverage should follow.
- **Edge crossings are measurably reduced, not eliminated, and the metric
  isn't the whole story (Ticket 3.6.3).** `ranker: 'longest-path'` +
  orthogonal (right-angle) edge routing together cut the real 67-template
  corpus's measured crossing count from 107 to 92 (~14%) — genuinely
  better, never "zero crossings," which is impossible in general for a
  non-planar graph. A real, honest complication: orthogonal routing alone
  actually *raises* the raw crossing count versus straight lines at the
  same ranker (66 → 92, see `docs/render-architecture.md`'s "Edge
  crossings and routing" section for the full before/after table) — kept
  anyway because it was an explicit visual request (right-angle lines,
  matching a supplied reference diagram) and reads as measurably cleaner
  in practice, even though the raw number alone doesn't capture that. A
  separate, distinct finding from the same manual review: for a corpus of
  many small *independent* templates specifically, diagram **width**
  (ADR 0006's shelf-packing) is the more dominant real clutter factor than
  crossings — untouched by this ticket, since that's the packing
  algorithm's own domain.
