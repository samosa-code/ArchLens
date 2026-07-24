# Render Architecture

Sprint 3's deliverable: turn a `GraphModel` (Sprint 2) into a self-contained
`index.html` a user opens directly, no server, no network, no build step of
their own. Ticket 3.1 built the bundle-and-inline pipeline itself, proven
against a minimal hard-coded "hello world" graph. Ticket 3.2 replaced the
hardcoded positions with a real layout algorithm (`@dagrejs/dagre`) and
added pan/zoom. Ticket 3.3 added click-for-details. Ticket 3.4 (done after
Sprint 3.5 landed) is the real `npx archlens <glob> --out <dir>` CLI that
wires all of it together end to end.

**Full design rationale:** [ADR 0005](adr/0005-render-bundling-and-browser-test-tooling.md)
(Ticket 3.1 — bundler, test tooling, Node/browser TypeScript split) and
[ADR 0006](adr/0006-layout-algorithm-and-pan-zoom-choice.md) (Ticket 3.2 —
layout algorithm, why layout runs client-side, pan/zoom, and the
visual-regression approach). This document is the "how it works"
companion.

## Module map

| Module | Runs in | Responsibility |
|---|---|---|
| `render/build.ts` | Node (`tsconfig.json`) | Bundles `browser/app.ts` via `esbuild`, inlines it + `style.css` into `template.html` |
| `render/types.ts` | Both | `RenderNode`/`RenderEdge`/`RenderContainer`/`RenderGraph` — deliberately DOM-free so both sides can share one definition (see ADR 0005's "real gotcha") |
| `render/layout.ts` | Both | `computeLayout()` — wraps `@dagrejs/dagre`, DOM-free (Ticket 3.2) |
| `render/fromGraphModelRaw.ts` | Node | The Sprint 2 1:1 projection — every resource its own box, nothing absorbed. `--raw`'s data source (Ticket A.10) |
| `render/fromArchitectureGraph.ts` | Node | The Sprint 3.5 "cooked" projection — `ArchitectureGraph → RenderGraph`, carrying everything the detail panel needs (Ticket 3.3) |
| `render/filterByLayer.ts` | Node | `filterRenderGraphByLayer()` — the `--layer=<list>`/`--hide-monitoring` post-filter over an already-built `RenderGraph` (Ticket 3.4) |
| `cli.ts` | Node | `npx archlens <glob...> --out <dir>` — the real end-to-end entry point: argv parsing, pipeline selection (`--raw` vs. the Architecture Generator), filtering, `--explain`, and writing the HTML (Ticket 3.4) |
| `render/browser/app.ts` | Browser (`tsconfig.browser.json`) | Reads the graph (baked in as a literal at bundle time), lays it out, draws it as SVG, wires up pan/zoom and click-for-details |
| `render/browser/template.html` | Browser | HTML skeleton: two placeholder comments for the inlined style/script, plus the static `#archlens-panel` skeleton (Ticket 3.3) |
| `render/browser/style.css` | Browser | Node/edge/panel/container/icon styling |
| `render/demo.ts` | Node | `npm run render:demo` — writes a real, openable `archlens-output/index.html` for manual verification, now running the real 5-template merge through the full `GraphModel → ArchitectureGraph → RenderGraph` pipeline (Ticket 3.3) |
| `render/icons.ts` | Node | `loadIconDataUris()` — scans `assets/icons/*.svg` into a `{serviceKey: data-URI}` map, baked into the bundle the same way as the graph (Ticket 3.6.2) |
| `render/crossings.ts` | Both | `countEdgeCrossings()` — a pure geometric edge-crossing-count metric over `LayoutEdge.points`, used to measure real before/after clutter (Ticket 3.6.3) |

## Pipeline

```
render/browser/app.ts (TS, DOM code)
     │
     ▼
esbuild.buildSync({ entryPoints: [app.ts], bundle: true, write: false,
                     format: 'iife', define: { __ARCHLENS_GRAPH_DATA__: JSON.stringify(graph) } })
     │
     ▼  (bundle text, graph data now a literal inside it — not fetched at runtime)
template.html's /*__ARCHLENS_SCRIPT__*/  ←── bundle text
template.html's /*__ARCHLENS_STYLE__*/   ←── style.css text
     │
     ▼
buildHtml(graph): string   — one self-contained HTML document
writeHtml(graph, path)     — buildHtml() + write to disk
```

`define`, not a global variable set by a separate script tag, is what
makes the data genuinely "baked in" rather than merely embedded-but-still-
timing-dependent: `app.ts` declares `declare const __ARCHLENS_GRAPH_DATA__:
DemoGraph` (never actually assigned in source — `esbuild` textually
replaces every reference to that identifier with the literal JSON at
bundle time), so there's exactly one script, no ordering dependency
between "set the data" and "read the data."

## Why the graph data isn't fetched separately

The ticket's acceptance criteria requires zero network requests once the
file is open. A separate `data.json` fetched via `fetch()` — even a
same-directory relative path — is still a network request from the
page's point of view (an intercepted `file://` sub-request), and would
fail entirely if the HTML file is ever emailed, copied alone, or opened
from a zipped download without its sibling data file. Baking the data
into the JS bundle text itself (via `esbuild`'s `define`) means the single
`.html` file is the *entire* artifact — nothing else needs to travel with
it.

## Layout (`render/layout.ts`)

`computeLayout(input)` wraps `@dagrejs/dagre`, converting its native
center-based node coordinates to top-left (directly usable as an SVG
`<rect>`'s `x`/`y`) and computing the overall diagram bounding box from
the actual positioned nodes rather than trusting dagre's own reported
size blindly. Deliberately generic (`{id, width, height}`/`{source,
target}`, no knowledge of labels or `RenderGraph`) and DOM-free — it lives
in `render/` (not `render/browser/`), so it's part of both TypeScript
programs without conflict, and is unit-testable directly in Node with no
browser (`__test__/layout.test.ts`), including the PO Question 14
1,000-node performance test. Why layout runs in the browser at all
(rather than once at Node build time) is ADR 0006's main subject —
short version: Sprint 5's cluster expand/collapse needs it.

An edge naming a node absent from the input is skipped, not thrown —
consistent with the parser/graph layers' established "degrade gracefully"
stance.

## Rendering and sizing (`render/browser/app.ts`)

Node size comes from real DOM text measurement (`createLabelMeasurer()`'s
hidden, off-screen `<text>` + `getComputedTextLength()`), not a
character-count heuristic — `layout.ts` itself is DOM-free and can't
measure text, so `app.ts`'s `sizeNode()` measures the real label first and
passes the actual pixel width in.

**Two node shapes (Ticket 3.6.3's visual redesign):** a node whose
`service` has a real icon (`assets/icons/<key>.svg`, via `icons.ts`)
renders as a big square icon (`NODE_ICON_SIZE`, 56px) with the label
centered below it — no bordered card around them, matching a supplied
AWS-style reference diagram. A node with no covered icon instead renders
as a roughly square placeholder box (`NODE_PLACEHOLDER_SIZE`, a 64px
floor) with the label centered inside — the classic bordered-rect look,
just square instead of the original wide 80×40 rectangle. Both shapes
still draw exactly one `<rect>` per node (real, visible border for the
placeholder shape; `fill: transparent; stroke: none` via
`.archlens-node--icon rect` for the icon shape) — a uniform click
hit-area and geometry contract across every node, regardless of which
shape it is.

Edges render as `<path>` through dagre's own routed polyline points
(`edgePointsToPathData()`), post-processed by `layout.ts`'s
`toOrthogonalPoints()` (Ticket 3.6.3) into an all-right-angle path — a
genuinely diagonal segment gets one vertical-horizontal-vertical elbow
inserted at its midpoint-y; a segment that's already axis-aligned is left
untouched. See "Edge crossings and routing" below for the measured
before/after numbers.

## Edge crossings and routing (Ticket 3.6.3)

Two independent, additive changes, measured separately and together
against the real 67-template `14-diverse-corpus` merge (207 nodes, 55
containers, 141 edges — `crossingBaseline.test.ts`'s own fixture) via a
new pure metric, `crossings.ts`'s `countEdgeCrossings()` (a standard
orientation/cross-product proper-segment-intersection test over every
distinct pair of edges' rendered polylines):

| Configuration | Crossing count |
|---|---|
| Original baseline (`ranker: 'network-simplex'` — dagre's default —, straight-line edges) | 107 |
| `ranker: 'longest-path'` alone, straight-line edges | 66 |
| `ranker: 'longest-path'` + orthogonal edge routing (**shipped**) | 92 |

**`ranker: 'longest-path'`** (both `layoutComponentCompound()` and
`layoutComponentFlatFallback()`'s `graph.setGraph()` calls) was the single
biggest lever found — tried per the ticket's own prescribed order before
touching anything else: `tight-tree` measured *worse* than the default
(115); `longest-path` measured substantially better (66, ~38% down from
the original baseline), at the same `nodesep`/`ranksep` and no diagram-size
cost. Widening `nodesep`/`ranksep`/`edgesep` further didn't reduce
crossings any more, just used more space, so the original spacing was
kept.

**Orthogonal edge routing** (`toOrthogonalPoints()` in `layout.ts`) was
added on top, per the ticket's own explicit ask for right-angle lines
matching a supplied reference diagram, not chosen purely to minimize the
raw number — and a real, honest finding: it actually *raises* the raw
crossing count relative to straight lines at the same ranker (66 → 92).
Each diagonal becomes a 3-segment elbow, and the added horizontal "jog"
segments are more prone to crossing other edges' jogs at similar
y-levels than a single diagonal would have been. Kept anyway: 92 is still
a real ~14% improvement over the original 107, and — as the ticket's own
testing requirements note — crossing count is a proxy for visual clutter,
not the definition of it; a manual eyeball pass against the same corpus
fixture (real Chromium screenshots, not just the number) confirmed
right-angle routing reads as noticeably cleaner than the original diagonal
lines, matching well-established graph-drawing readability results.

**A distinct, honest finding from that same eyeball pass**: for this
specific 67-*independent*-template corpus, the dominant clutter factor
isn't really edge crossings at all — it's the sheer *width* of the
shelf-packed diagram (ADR 0006's packing produces one very wide,
mostly-one-row-tall strip for many small disconnected components side by
side). Real crossings are concentrated within each small component's own
subgraph, which a zoomed screenshot confirmed route cleanly with no
diagonal lines left. Diagram width/shape is ADR 0006's/the packing
algorithm's domain, not something this ticket was scoped to change.

`crossingBaseline.test.ts` locks the shipped combination in with headroom
(`<= 100`, not brittle to an exact `92`) against the same real fixture, so
a future change can't silently regress this back toward the original
baseline.

## Pan/zoom

A `<g id="archlens-viewport">` wraps all rendered content; its `transform`
attribute (`translate(x,y) scale(s)`) is the entire pan/zoom mechanism —
no library (see ADR 0006). Drag (pointer events) adjusts `x`/`y`; wheel
adjusts `s`, anchored so the point under the cursor stays fixed
(`worldX`/`worldY` computed from the *current* transform before applying
the new scale), clamped to `[0.05, 4]`. On first render, `computeInitialViewport()`
scales/centers the diagram to fit the viewport — otherwise a large (e.g.
1,000-node) diagram would open showing only a small corner of itself.

## Click-for-details panel (Ticket 3.3)

`#archlens-panel` is a static, always-present skeleton in `template.html`
(hidden via its `hidden` attribute) — never built fresh per click.
Clicking a `.archlens-node` populates its header (label,
`type · layer`, `file:line`), a security-finding callout (shown only when
the node actually has one — never for every node), one collapsible
section per absorbed-resource group that has anything in it (an empty
group is omitted entirely, never rendered blank), and a Connections
section listing every `RenderEdge` touching the node with its role label
and an arrow showing which side is which (`verb → other` outbound,
`verb ← other` inbound).

**Per-item finding tint, not per-section.** Only the specific absorbed
resource a finding names (`RenderAbsorbedResource.hasFinding`, computed in
`fromArchitectureGraph.ts` by matching `Badge.sourceNodeId`) gets the
warning style — never every item in its section, which the original
design mockup got wrong (recorded in `SPRINT-PLAN.md` as a bug in the
mockup, not something to reproduce).

**A real bug this ticket found and fixed:** `setupPanZoom`'s
`pointerdown` handler called `svg.setPointerCapture(...)`
unconditionally. Per spec, pointer capture redirects the matching
`pointerup` — and the `mouseup` synthesized from it — to the capturing
element (`svg`) regardless of where the pointer physically is. Since
browsers compute the synthetic `click` event from where `mousedown` and
`mouseup` landed, capturing the pointer to `svg` on every `pointerdown`
meant a click starting on a node's `mousedown` but redirected to `svg` on
`mouseup` never produced a `click` on the node at all — Playwright's
real mouse-simulated `.click()` silently did nothing, while a synthetic
`dispatchEvent(new MouseEvent('click'))` worked fine, which is what
isolated the cause. Fixed by skipping drag-initiation entirely when a
`pointerdown`'s target is inside a `.archlens-node` — panning from empty
canvas is unaffected.

**"View source" is real `file:line` text, not a clickable link** — a
statically-exported, self-contained HTML file has no real target to jump
to (no editor integration, no browser support for `file://...#Lnn`), and
a non-functional link that looks clickable would be dishonest UI.

## Container nesting: real boundary rectangles (Ticket 3.6.1)

Containers (`RenderContainer[]`, from `fromArchitectureGraph.ts`'s
`ArchitectureGraph.containers`) were data-only through Ticket 3.3 —
`fromArchitectureGraph.ts` carried `RenderNode.containerId`/
`RenderContainer.parentId`, but nothing read them, so any VPC-only
template rendered a blank canvas even with real containers present (found
via a real usage question — see `SPRINT-PLAN.md`'s Sprint 3.6 note).

`layout.ts`'s `computeLayout()` now lays containers out via
`@dagrejs/dagre`'s own compound-graph support (`new dagre.graphlib.Graph({
compound: true })`, `setParent()`), extracting a real `x/y/width/height`
for every container the same way it does for nodes. Every container is
given an explicit `minWidth`/`minHeight` floor sized from its label
(`sizeContainer()` in `app.ts`, mirroring `sizeNode()`) — confirmed
directly that dagre gives a childless, unsized cluster node no
`width`/`height` at all otherwise, while a populated container still
auto-expands well beyond that floor to fit its real contents.

`findConnectedComponents()` treats container membership as connectivity,
not just real edges — a VPC and a subnet connected *only* by containment
(no edge between them at all) must still land in the same connected
component, or they'd risk being packed onto different shelves.

**A real `@dagrejs/dagre` limitation, not an ArchLens bug:** compound mode
combined with certain edge/cluster shapes throws `"Not possible to find
intersection inside of the rectangle"` from inside dagre's own
edge-routing — confirmed via direct experimentation this isn't simply a
scale problem (a 200-node/20-container case fails; an otherwise-identical
500-node case doesn't) and that tuning `ranker` or container sizes doesn't
reliably avoid it. `layoutComponent()` tries the compound layout first and
falls back to `layoutComponentFlatFallback()` on any thrown error: a flat
(non-compound) dagre layout for real node positions, with each
container's box then computed as the padded bounding-box union of its
members'/child containers' positions, deepest-first. See
`LIMITATIONS.md` for the user-facing framing of this trade-off.

`app.ts`'s `renderSvgContent()` draws one `.archlens-container` rect +
label per entry in `layout.containers`, appended to the SVG *before* the
edge/node loops so containers always paint as the backmost layer, and
sorted parent-before-child (`sortContainersByDepth()`) so nesting reads
correctly when boundaries are adjacent.

## The CLI (Ticket 3.4)

`cli.ts`'s `main()`: parse argv (`parseArgs()`) → resolve glob patterns
to real files (`resolveInputFiles()`, unchanged since Sprint 2) →
`loadTemplates()` → `mergeGraphs()` → `buildRenderGraph()` (picks `--raw`'s
`fromGraphModelRaw.ts` or the default `generate()` +
`fromArchitectureGraph.ts`, then applies `--layer`/`--hide-monitoring` via
`filterByLayer.ts`, and builds the `--explain` report string when asked)
→ `writeHtml()`. `--out` defaults to `./archlens-output`, **relative to
the caller's `process.cwd()`**, never to wherever the package itself is
installed — the opposite of how `render/demo.ts`/`architecture/demo.ts`
anchor their own fixed dev-only output paths, and a real bug (below) when
the two got confused.

**A real bug found by the end-to-end subprocess test, not by
inspection:** the first draft computed the default output directory via
`fileURLToPath(new URL('../archlens-output/', import.meta.url))` — anchored
to `cli.ts`'s own location. That's exactly right for the fixed dev-only
demo scripts, and exactly wrong for a real CLI: every user's diagram
would have been written into wherever `archlens` happens to be installed,
not their own project directory. Caught by a subprocess test that
actually changes `cwd` before invoking the CLI (`cli.e2e.test.ts`'s
"default output path" test) — a unit test calling `parseArgs()` directly
would never have noticed, since it never has its own separate process
CWD to get wrong.

**`--explain`/`--layer`/`--hide-monitoring` are documented no-ops with
`--raw`,** not silently ignored: `buildRenderGraph()` prints a stderr
notice when any of them are combined with `--raw`, since the 1:1 view has
no abstraction decisions or layers for them to act on.

## Testing approach

`src/render/__test__/build.test.ts` (Ticket 3.1) — two tiers:

1. **Static structure checks** — the returned HTML string has no
   `<script src=...>`/`<link href=...>`, the graph data appears as literal
   text (not a `.json` reference), and two different input graphs produce
   different output (proving the data is genuinely re-baked per call, not
   cached).
2. **Real headless-browser verification** (the ticket's own stated
   method, done for real rather than by inspection) — using `playwright`'s
   `chromium` launcher directly inside `vitest`: opens the generated file
   and asserts zero network requests beyond the initial `file://`
   navigation; opens it again with the browser context's `offline: true`
   (the AC's literal wording, "verify by opening with network disabled");
   asserts the actual rendered DOM has the correct node/edge counts and
   labels; and asserts zero console errors.

**Mutation-tested**: temporarily added a real external `<script src=
"https://example.invalid/fake.js">` to the template and confirmed three
independent tests all caught it — the static regex check, the
zero-network-requests check (which actually attempted and failed to
resolve the fake domain), and the zero-console-errors check (which
surfaced the resulting `ERR_NAME_NOT_RESOLVED`). All three fail together
when a real regression is introduced, then all three were confirmed
passing again after reverting.

`src/render/__test__/render.test.ts` (Ticket 3.2):

1. **20+ node acceptance criteria** — a real 25-node/24-edge graph, opened
   in an actual browser: correct counts, and (the stronger, real-DOM
   version of `layout.test.ts`'s own unit-level check) no two *rendered*
   `<rect>` bounding boxes overlap, read directly from the live page.
2. **Pan/zoom, behaviorally** — simulates a real pointer drag and asserts
   `#archlens-viewport`'s `transform` translation changed by exactly the
   drag delta; simulates a real wheel event and asserts the scale
   changed; and a dedicated test confirms repeated zoom-in stays clamped
   at the configured maximum rather than growing unbounded (mutation-
   tested: removing the clamp made the scale reach ~3×10¹⁰ before the test
   caught it).
3. **Visual regression** — an SVG-markup snapshot via `vitest`'s built-in
   `toMatchSnapshot()` (see ADR 0006 for why not a pixel-image snapshot).
   Mutation-tested: changing a rendered attribute (`rx="6"` → `rx="99"`)
   was confirmed to fail the snapshot, then reverted.
4. **PO Question 14, in a real browser** — builds and opens a 1,000-node
   graph, asserting both the `buildHtml()` call and the page reaching a
   rendered state each complete within a 10s budget, on top of
   `layout.test.ts`'s own faster, browser-free 1,000-node layout-only
   check.

`src/render/__test__/panel.test.ts` (Ticket 3.3) — real-browser, real
click events, following the same `beforeAll`-shared-browser pattern:
header content, per-group section presence/omission and count badges,
per-item finding tint (not per-section), findings-callout presence/
absence, Connections labeling and direction, close button, and that
clicking a different node replaces panel content rather than stacking.
Assertions use plain `Locator` methods (`.textContent()`, `.count()`,
`.isHidden()`, `.evaluate()` for class checks) rather than
`@playwright/test`'s extended matchers, which aren't registered under
this project's own `vitest`-based `expect` — confirmed directly after the
first draft of this file used them and failed with "Invalid Chai
property" errors. `src/render/__test__/fromArchitectureGraph.test.ts`
covers the Node-side projection: real-fixture cases (absorbed groups,
containers, connector-derived edge kinds) plus synthetic cases for
finding/tint logic the real pipeline can't produce yet (no security/cost
rule engine exists before Sprint 9).

`src/render/__test__/filterByLayer.test.ts` (Ticket 3.4) — pure-function
tests for the `--layer`/`--hide-monitoring` post-filter, including the
"a node with no `layer` at all always survives" case (the `--raw`
projection) and composition (`--hide-monitoring` wins even when
`monitoring` is explicitly in the `--layer` allowlist). `src/__test__/cli.test.ts`
covers `parseArgs()`/`buildRenderGraph()` directly (fast, no subprocess).
`src/__test__/cli.e2e.test.ts` is Ticket 3.4's own explicit testing
requirement — the CLI run as a real subprocess against real fixtures,
using the project's own `tsc` build (`dist/cli.js`) rather than bundling
`cli.ts` with `esbuild` the way `render/build.ts` bundles `browser/app.ts`:
that was tried first and broke at runtime, since `jsonc-parser`'s UMD
module does a dynamic `require('./impl/format')` esbuild can't resolve
once flattened into one file. The real project build has no such
problem — proven, and it's exactly what every other demo script here
already does.

## A note on test-suite stability

Adding a second Chromium-launching test file (this ticket's
`render.test.ts`, alongside Ticket 3.1's `build.test.ts`) made the full
suite noticeably more prone to timeouts under `vitest`'s default parallel-
file execution. Root-caused, not just timeout-inflated away: both files
were launching and tearing down a fresh Chromium process on *every test*
(`beforeEach`/`afterEach`) — each launch is itself several OS processes,
not one. Fixed at the source first — both files now launch **one** shared
browser per file (`beforeAll`/`afterAll`), only a page/temp directory per
test — and `vitest.config.ts`'s `testTimeout`/`hookTimeout` were then
raised to 30s as headroom for genuine scheduling contention, confirmed
(not assumed) not to be masking a real slowdown: the 1,000-node layout
test completes in ~7.5s total (the whole file) in isolation, comfortably
under its own internal 5s budget.

## Related documents

- [ADR 0005: Render bundling and browser test tooling](adr/0005-render-bundling-and-browser-test-tooling.md)
- [ADR 0006: Layout algorithm, pan/zoom, and visual-regression approach](adr/0006-layout-algorithm-and-pan-zoom-choice.md)
- [`docs/graph-architecture.md`](graph-architecture.md) — Sprint 2's
  `GraphModel` this sprint renders (full wiring: Ticket 3.4)
- [`docs/architecture-generation.md`](architecture-generation.md) —
  Sprint 3.5's `ArchitectureGraph`, the shape `fromArchitectureGraph.ts`
  projects into `RenderGraph` (Ticket 3.3)
- [`docs/developer-guide.md`](developer-guide.md) — project-wide doc index
