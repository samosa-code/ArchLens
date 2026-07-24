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

## HTML bundle scaffolding (Sprint 3, Ticket 3.1)

Turns a graph into one self-contained `index.html`: `esbuild` bundles the
browser-side renderer with the graph data baked in as a literal (not
fetched), then a small inline step embeds the bundle and its CSS into an
HTML template. Zero network requests once opened — verified with a real
headless browser (`playwright`), not just by inspecting the output text.
Introduced this project's first Node/browser TypeScript split
(`tsconfig.json` vs `tsconfig.browser.json`).

**Modules:** `src/render/build.ts`, `src/render/types.ts`,
`src/render/browser/` (`app.ts`, `template.html`, `style.css`),
`src/render/demo.ts`

**Full detail:** [`docs/render-architecture.md`](render-architecture.md) —
the bundle/inline pipeline, why the graph data can't be a separate fetched
file, and the real TypeScript-`exclude` gotcha this ticket surfaced.

**Related:** [ADR 0005](adr/0005-render-bundling-and-browser-test-tooling.md)
(bundler + browser-test-tooling choices)

## Graph layout, pan/zoom & basic SVG rendering (Sprint 3, Ticket 3.2)

Replaces Ticket 3.1's hardcoded node positions with a real layout
algorithm (`@dagrejs/dagre` — the actively-maintained fork, not the
abandoned original `dagre` package) running client-side, plus drag-to-pan/
wheel-to-zoom (a small custom implementation, no `d3-zoom` dependency).
The input shape evolved from Ticket 3.1's toy `DemoGraph` to
`RenderGraph`/`RenderNode`/`RenderEdge` — a thin, stable projection of
Sprint 2's `GraphNode`/`GraphEdge` (real `GraphModel` wiring is still
Ticket 3.4). Layout computation itself (`render/layout.ts`) is DOM-free
and runs identically in Node, so it's unit-tested directly without a
browser — including the PO Question 14 1,000-node performance target.

**Modules:** `src/render/layout.ts`, `src/render/browser/app.ts` (rewritten)

**Full detail:** [`docs/render-architecture.md`](render-architecture.md)
— why layout runs in the browser rather than at Node build time (Sprint
5's cluster expand/collapse needs it), the pan/zoom mechanism, and the
SVG-markup-snapshot visual-regression approach.

**Related:** [ADR 0006](adr/0006-layout-algorithm-and-pan-zoom-choice.md)
(layout algorithm, pan/zoom, visual regression, and a test-suite-health
fix — sharing one browser process per test file instead of per test —
that came out of adding this ticket's tests)

**Try it:** `npm run render:demo` writes a real, openable
`archlens-output/index.html`; try dragging to pan and scrolling to zoom.

---

## Click-for-details side panel (Sprint 3, Ticket 3.3)

Clicking a node opens `#archlens-panel` (a static, always-present
skeleton toggled via its `hidden` attribute) with header info
(label/type/layer/file:line), a security-finding callout shown only when
present, one collapsible section per absorbed-resource group that
actually has something in it, and a Connections section listing
arch-level edges with role labels. Per-item warning tint only marks the
specific item a finding names — never every item in its section.

Pulled forward `fromArchitectureGraph.ts` (the `ArchitectureGraph →
RenderGraph` projection originally filed under Ticket 3.4) as this
ticket's own prerequisite, since the panel can't show `ArchNode`-shaped
content without it — see `SPRINT-PLAN.md`'s 2026-07-23 scope decision.

**A real bug found via real-browser testing:** the pan/zoom handler's
unconditional `svg.setPointerCapture()` on every `pointerdown` silently
broke node clicks entirely (pointer capture redirects the matching
`mouseup` to `svg`, so the browser never synthesizes a `click` on the
node). Fixed by skipping drag-initiation when the `pointerdown` target is
inside a `.archlens-node`.

**Modules:** `src/render/fromArchitectureGraph.ts`,
`src/render/browser/app.ts` (panel logic), `src/render/types.ts`
(`RenderAbsorbedResource`/`RenderBadge`/`RenderContainer`)

**Full detail:** [`docs/render-architecture.md`](render-architecture.md)
— the panel's exact content model, the pointer-capture bug, and what was
deliberately deferred at the time (a real "View source" link — no real
target/mechanism exists for one yet). Visual container nesting was the
other deferred item here — since built, see Sprint 3.6's Ticket 3.6.1
below.

**Try it:** `npm run render:demo` now runs the real 5-template merge
through the full `GraphModel → ArchitectureGraph → RenderGraph` pipeline
— click any node to see its detail panel.

---

## CLI: `npx archlens <glob> --out <dir>` (Sprint 3, Ticket 3.4)

`cli.ts`'s `main()` wires the full pipeline end to end:
`resolveInputFiles()` → `loadTemplates()` → `mergeGraphs()` →
`buildRenderGraph()` (picks `--raw` or the Architecture Generator, applies
`--layer`/`--hide-monitoring` via `filterByLayer.ts`, builds the
`--explain` report) → `writeHtml()`. Sprint 2's `resolveInputFiles()`/
`summarize()` are unchanged and still exported (own tests still pass);
`summarize()` just isn't what the CLI prints by default anymore.

**Naming:** implemented as `archlens`, not the sprint plan's own ticket
text (`cfn-viz`, an earlier working name) — `internal-docs/PRD.md` (the
authoritative spec), `package.json`'s `"name"`, and every other doc in
this repo already consistently say `archlens`.

**A real bug found by the end-to-end subprocess test, not by
inspection:** the default `--out` path was first anchored to `cli.ts`'s
own install location (`import.meta.url`) — exactly right for the fixed
dev-only demo scripts, exactly wrong for a real CLI, since every user's
diagram would land inside wherever `archlens` is installed rather than
their own project. A subprocess test that actually changes `cwd` before
invoking the CLI caught it directly; a unit test calling `parseArgs()` in
the same process never would have, since it has no separate CWD to get
wrong. Fixed to `process.cwd()`-relative.

**Modules:** `src/cli.ts`, `src/render/filterByLayer.ts`

**Full detail:** [`docs/render-architecture.md`](render-architecture.md)
— the full pipeline wiring and the CWD bug in detail.

**Try it:** `npx archlens ./examples/01-simple-lambda/template.yaml --out ./diagram`
(or, in this repo without a global install: `npm run demo -- <glob> --out <dir>`).
See the README's "CLI usage" section for the full flag reference.

---

## Architecture Generator (Sprint 3.5, Tickets A.1–A.11)

Turns Sprint 2's raw, nothing-discarded `GraphModel` into a reduced,
human-readable `ArchitectureGraph` via six deterministic passes:
classify (rule table → structural heuristic → kept-unknown) → build
containers → resolve detail/connector ownership → emit connector edges
against the intact graph → reparent + dedupe (provenance unioned, never
discarded) → layer-index-driven direction inference + the synthetic
Internet/Users node. An accounting invariant (`decisions.length ===
graph.nodes.length`) holds at every stage — every input resource has
exactly one recorded fate, always inspectable via `--explain`.

**Modules:** `src/architecture/{types,rules,classify,containers,
ownership,connectors,reparent,layers,synthetic,metadata,generate,
explain}.ts` — see `docs/architecture-generation.md`'s module map for
each file's exact responsibility.

**Full detail:** [`docs/architecture-generation.md`](architecture-generation.md)
— the six-pass pipeline walked in order, the module map, testing
approach, and the Ticket A.11 corpus-validation results (98.5% rule
coverage; the documented SAM reduction-ratio shortfall, root-caused not
hidden; the two real eyeball-test findings).

**Related:** [ADR 0007](adr/0007-architecture-abstraction-layer.md)
(the four-role split; why layers are rule-assigned, not
topology-derived) · [ADR 0008](adr/0008-connector-resources-as-edges.md)
(the sprint's single most important decision — connector resources
become edges, not absorbed details) · [ADR 0009](adr/0009-layer-and-direction-inference.md)
(direction inference; the synthetic Internet/Users node) ·
[`internal-docs/SPRINT-PLAN.md`](../internal-docs/SPRINT-PLAN.md) (the
full A.1–A.11 ticket history and findings)

**Try it:** `npm run arch:demo` (a real 5-template merge — components by
layer, container tree, connector-derived edges, direction-inferred/
flagged edges, the synthetic node) and `npm run arch:corpus-report`
(per-fixture reduction ratio/rule coverage across the full 67-template
corpus).

---

## Container nesting: real boundary rectangles (Sprint 3.6, Ticket 3.6.1)

Closes the gap Ticket 3.3 deliberately deferred: `RenderGraph.containers`
had real data (VPC/Subnet/cluster/stack/account/region boundaries) since
Ticket 3.3, but nothing ever read it — confirmed directly that a VPC-only
template (`examples/02-complex-vpc-nat`: 0 `ArchNode`s, 5 `ArchContainer`s)
rendered a completely blank canvas. `layout.ts`'s `computeLayout()` now
lays containers out via `@dagrejs/dagre`'s compound-graph mode
(`compound: true`, `setParent()`), and `app.ts` draws one
`.archlens-container` rect + label per container, behind every edge/node.

**Two real findings, both from this ticket's own mutation-testing
discipline, not user feedback:** (1) a childless, unsized dagre cluster
node gets no `width`/`height` at all — fixed by giving every container an
explicit label-derived `minWidth`/`minHeight` floor. (2) dagre's own
compound-mode edge-routing throws on certain moderate-scale shapes (not a
pure scale effect — confirmed a 500-node case with the same shape doesn't
crash) — fixed via a `layoutComponentFlatFallback()` that computes
container boxes as a manual bounding-box union when the primary compound
layout throws.

**Modules:** `src/render/layout.ts` (`LayoutContainerInput`,
`layoutComponentCompound`/`layoutComponentFlatFallback`,
`findConnectedComponents` now treating containment as connectivity),
`src/render/browser/app.ts` (`sizeContainer()`, container-drawing loop in
`renderSvgContent()`), `src/render/browser/style.css`
(`.archlens-container`)

**Full detail:** [`docs/render-architecture.md`](render-architecture.md#container-nesting-real-boundary-rectangles-ticket-361)
— the dagre compound-mode mechanism, the two mutation-testing findings,
and the flat-layout fallback's trade-offs. [`LIMITATIONS.md`](../LIMITATIONS.md)
states the fallback's user-facing framing.

**Try it:** `npm run render:demo`, or `npx archlens examples/02-complex-vpc-nat/template.yaml`
— the VPC + 4 subnets now render as real nested boxes instead of a blank
canvas.

---

## Real AWS service icons (Sprint 3.6, Ticket 3.6.2)

`RenderNode.service` (e.g. `'lambda'`, `'dynamodb'`) has existed since
Ticket 3.3 as a plain-text subtitle only — real icon graphics were
originally scoped to Sprint 13. Pulled forward here once real icon assets
became available: the user supplied the official AWS Architecture Icons
pack (`Architecture-Service-Icons`), from which the ~50 service keys
`src/architecture/rules.ts` actually uses were identified, matched to
their official filenames, and curated down + renamed to `assets/icons/
<service-key>.svg` (SVG only — the pack's PNGs, other icon families
(`Resource-Icons`, `Category-Icons`, `Architecture-Group-Icons`), and
`__MACOSX`/`.DS_Store` zip artifacts were all deleted, not kept
"just in case"). 44 of ~50 keys have a real icon; `datapipeline` and
`iotanalytics` don't (both legacy/deprecated services absent from the
current pack) and correctly fall back to the pre-existing text subtitle.

**Adding icon coverage for a new service key:** drop an SVG at
`assets/icons/<service-key>.svg`, named to match the exact string
`rules.ts` assigns that type's `service` field. Nothing else to register
or wire up — `icons.ts`'s `loadIconDataUris()` scans the directory at
build time and keys the result by filename, so there is no separate
map to fall out of sync with the files on disk. A `.svg` file that isn't
actually valid SVG markup fails the build loudly (an explicit error
naming the file), rather than silently shipping a broken icon.

**Mechanism:** `build.ts` calls `loadIconDataUris('assets/icons/')` and
bakes the resulting `{serviceKey: data-URI}` map into the bundle via the
same `esbuild` `define` mechanism `__ARCHLENS_GRAPH_DATA__` already uses
— each icon becomes a literal `data:image/svg+xml;base64,...` string in
the shipped JS, never a `<img src="...">` pointing at a file the browser
would need to fetch (Ticket 3.1's "one file, zero network requests"
invariant, re-verified by `build.test.ts` after this change, not just
assumed to still hold). `app.ts`'s node-drawing loop renders a real
`<image class="archlens-node-icon">` in place of the old
`.archlens-node-service` text — never both on the same node — sized from
a fixed 20×20 box to the label's left, with `sizeNode()` reserving that
extra width only for nodes that actually have a covered service (an
uncovered service's node stays exactly as narrow as before this ticket).

**Modules:** `src/render/icons.ts` (`loadIconDataUris`), `src/render/build.ts`
(`ICONS_DIR`, wiring the icon map into esbuild's `define`),
`src/render/browser/app.ts` (icon-vs-text-fallback branch in
`renderSvgContent()`, `sizeNode()`'s `hasIcon` parameter),
`src/render/browser/style.css` (`.archlens-node-icon`)

**Full detail:** [`LIMITATIONS.md`](../LIMITATIONS.md) states the
partial-coverage framing (which 2 keys fall back to text, and why).

**Try it:** `node dist/cli.js "examples/03-multi-stack-ecs-fargate/**/template.yaml" --out <dir>`
then open `<dir>/index.html` — the Lambda/DynamoDB/etc. nodes in that
fixture render their real AWS icons instead of a plain-text service name.

---

## Edge crossing reduction & node visual redesign (Sprint 3.6, Ticket 3.6.3)

Two changes, both driven directly by a user-supplied reference diagram:
right-angle (orthogonal) edge routing in place of straight diagonal lines,
and a redesigned node shape — a big square icon with its label below it,
or a square placeholder box with the label inside for a node with no
covered icon (see "Real AWS service icons" above for coverage).

**Measure first, per the ticket's own prescribed order:** before changing
anything, built a real, pure metric (`crossings.ts`'s
`countEdgeCrossings()`) and measured it against the real 67-template
`14-diverse-corpus` merge: 107 crossings at dagre's default `ranker:
'network-simplex'`. Tried `tight-tree` (worse, 115) and `longest-path`
(better, 66 — ~38% down, the single biggest lever, no diagram-size cost)
before touching routing at all. Orthogonal routing (`toOrthogonalPoints()`
in `layout.ts`) was added on top per the ticket's explicit visual ask, not
purely to chase the number — and a real, honestly-recorded finding: it
raises the metric back up to 92 (still ~14% better than the original 107,
but worse than straight lines at the same ranker), because each diagonal
becomes a 3-segment elbow whose horizontal "jog" is itself more prone to
crossing other edges' jogs. Kept anyway: a manual eyeball pass (real
Chromium screenshots of the same corpus fixture) confirmed right-angle
routing reads as genuinely cleaner, and the ticket's own testing
requirements explicitly acknowledge the metric alone doesn't capture that.

**Modules:** `src/render/crossings.ts` (`countEdgeCrossings`),
`src/render/layout.ts` (`toOrthogonalPoints`, the `ranker: 'longest-path'`
change in both `graph.setGraph()` calls), `src/render/browser/app.ts`
(`sizeNode()`'s two-shape branch, the icon/placeholder draw logic in
`renderSvgContent()`), `src/render/browser/style.css`
(`.archlens-node--icon rect`)

**Full detail:** [`docs/render-architecture.md`](render-architecture.md#edge-crossings-and-routing-ticket-363)
— the full before/after crossing-count table, and the separate finding
that diagram *width* (not crossings) is the dominant clutter factor for
a corpus of many independent templates specifically. [`LIMITATIONS.md`](../LIMITATIONS.md)
states the user-facing framing.

**Try it:** `npm run render:demo`, or open any previously-generated
diagram — every edge now routes in clean right angles, and every icon-
covered node renders as a big colored square with its label underneath.

---

*(Later sprints' search, blast radius, diff — and Sprint 3's own remaining
tickets 3.3–3.4 — get their own entries here as they're built.)*
