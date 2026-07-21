# Render Architecture

Sprint 3's deliverable: turn a `GraphModel` (Sprint 2) into a self-contained
`index.html` a user opens directly, no server, no network, no build step of
their own. Ticket 3.1 built the bundle-and-inline pipeline itself, proven
against a minimal hard-coded "hello world" graph. Ticket 3.2 (this
document's current scope) replaces the hardcoded positions with a real
layout algorithm (`@dagrejs/dagre`), adds pan/zoom, and upgrades the input
shape from Ticket 3.1's toy `DemoGraph` to `RenderGraph` — a thin, stable
projection of Sprint 2's `GraphNode`/`GraphEdge` (real `GraphModel` wiring
is still Ticket 3.4's job; click-to-detail is Ticket 3.3's).

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
| `render/types.ts` | Both | `RenderNode`/`RenderEdge`/`RenderGraph` — deliberately DOM-free so both sides can share one definition (see ADR 0005's "real gotcha") |
| `render/layout.ts` | Both | `computeLayout()` — wraps `@dagrejs/dagre`, DOM-free (Ticket 3.2) |
| `render/browser/app.ts` | Browser (`tsconfig.browser.json`) | Reads the graph (baked in as a literal at bundle time), lays it out, draws it as SVG, wires up pan/zoom |
| `render/browser/template.html` | Browser | HTML skeleton with two placeholder comments for the inlined style/script |
| `render/browser/style.css` | Browser | Minimal node/edge styling |
| `render/demo.ts` | Node | `npm run render:demo` — writes a real, openable `archlens-output/index.html` for manual verification (now a 24-node sample graph) |

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

Node size is a heuristic from label length (`sizeNode()`) — real DOM text
measurement isn't available to `layout.ts` (it's DOM-free, and runs
identically in Node for its own tests), so this is a deliberate
approximation, not an oversight. Nodes render as `<rect>` + centered
`<text>`; edges render as `<path>` through dagre's own routed polyline
points (`edgePointsToPathData()`), not straight lines computed
independently of the actual layout.

## Pan/zoom

A `<g id="archlens-viewport">` wraps all rendered content; its `transform`
attribute (`translate(x,y) scale(s)`) is the entire pan/zoom mechanism —
no library (see ADR 0006). Drag (pointer events) adjusts `x`/`y`; wheel
adjusts `s`, anchored so the point under the cursor stays fixed
(`worldX`/`worldY` computed from the *current* transform before applying
the new scale), clamped to `[0.05, 4]`. On first render, `computeInitialViewport()`
scales/centers the diagram to fit the viewport — otherwise a large (e.g.
1,000-node) diagram would open showing only a small corner of itself.

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
- [`docs/developer-guide.md`](developer-guide.md) — project-wide doc index
