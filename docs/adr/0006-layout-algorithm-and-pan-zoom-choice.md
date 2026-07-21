# ADR 0006: Layout algorithm, pan/zoom, and visual-regression approach

**Status:** Accepted
**Date:** 2026-07-21
**Related:** Sprint 3, Ticket 3.2 (`src/render/layout.ts`, `src/render/browser/app.ts`)

## Context

Ticket 3.2 takes Ticket 3.1's "hello world" renderer (hardcoded x/y
positions) and replaces it with a real layout algorithm, plus pan/zoom and
the testing this ticket's own AC requires: no overlapping nodes at 20+
resources, responsive at 1,000 (PO Question 14), a visual-regression
snapshot, and a dedicated layout-correctness unit test.

## Decision

### Layout: `@dagrejs/dagre`, not the original `dagre` package

The PRD suggests `dagre` by name. Checked before installing anything (the
same diligence ADR 0001 applied to parser libraries): the original `dagre`
package on npm hasn't published since 2022-06-14 — over four years stale.
Its own README states plainly: *"There are 2 versions on NPM, but only the
one in the DagreJs org is receiving updates right now."* `@dagrejs/dagre`
was last published 2026-03-22, is the same API, and is the community-
adopted continuation. Same reasoning ADR 0001 used to reject `json-to-ast`
for the parser, applied here before any code was written against the
wrong package.

### Layout computation runs in the browser, not at Node build time

Two architectures were possible: compute positions once at HTML-generation
time (Node-side, embed the result as static data) or compute them in the
browser after the page loads (ship the graph structure, run `dagre`
client-side). **Browser-side was chosen because Sprint 5's own plan
requires it, not because it was assumed to be nicer.** Ticket 5.4
(expand/collapse clusters) requires "smoothly... without layout jank" and
"doesn't require a full page reload" — expanding a cluster changes which
nodes are visible, which means a genuinely different layout, computed on
the fly. Baking positions in at Node build time would mean pre-computing
every possible expand/collapse combination (infeasible) or falling back to
a totally different mechanism later, only to redo this ticket's work.
Running `dagre` client-side from the start means Ticket 3.2's own
architecture is what Sprint 5 needs, not something to be reworked then.

### `layout.ts` has no DOM dependency, deliberately

`computeLayout()` takes a generic `{id, width, height}`/`{source, target}`
shape — no knowledge of labels, `RenderGraph`, or anything rendering-
specific — and lives in `render/` (not `render/browser/`), so it's
included in *both* `tsconfig.json` and `tsconfig.browser.json` without
conflict (a DOM-free file causes no problem being typechecked under a DOM
lib; the reverse isn't true, per ADR 0005's `exclude`-doesn't-stop-
imports finding). This is also what makes the PO Question 14 1,000-node
performance test fast and simple: it runs as a plain Node unit test, no
browser needed, isolating "is the algorithm itself fast" from "does the
browser render it responsively," which is checked separately.

### Pan/zoom: a small custom implementation, not `d3-zoom`

A ~50-line pointer-events (drag) + wheel (cursor-anchored zoom, clamped to
`[0.05, 4]`) implementation, rather than adding `d3-zoom` as a dependency.
`d3-zoom` is a fine library, but pulling in a piece of the d3 ecosystem for
what's fundamentally "translate/scale a `<g>` element in response to two
event types" repeats the same tradeoff ADR 0005 already made for HTML
inlining: a well-understood, small, in-house implementation over a
dependency whose surface area (touch gestures, momentum, d3-selection
integration) mostly goes unused here. Revisit if a future ticket needs
gesture support this implementation doesn't have (e.g. pinch-to-zoom on
touch devices, not in this ticket's scope).

### Visual regression: an SVG-markup snapshot (`vitest`'s own `toMatchSnapshot()`), not pixel-image comparison

The ticket asks for a "visual regression test (snapshot)." Two ways to
satisfy that literally: compare rendered *pixels* (a PNG screenshot
against a stored baseline) or compare the rendered *SVG markup* (which
fully determines what gets drawn) as a text snapshot. Chose the latter:

- No new dependency — `vitest` has built-in snapshot support
  (`toMatchSnapshot()`); pixel comparison would need `pixelmatch`/
  `looks-same` or `@playwright/test`'s own screenshot assertions (which
  ADR 0005 already declined to add as a second test runner).
- Pixel snapshots are notoriously environment-sensitive (font rendering,
  anti-aliasing, GPU differences across machines/CI) — a common source of
  false-positive failures unrelated to any real regression. An SVG-markup
  snapshot is deterministic wherever `esbuild`/`dagre` themselves are
  deterministic, which they are for a fixed input graph and fixed
  viewport.
- It still catches exactly the class of bug "visual regression" testing
  is meant to catch: confirmed by deliberately changing a rendered
  attribute (`rx="6"` → `rx="99"`) and observing the snapshot test fail,
  then reverting.

This is a genuine scope interpretation, not a corner cut silently — worth
revisiting if a future ticket's own AC specifically needs pixel-level
fidelity (e.g. Sprint 8's SVG export, which the PRD says must "look
exactly like what was on screen").

### Test-suite health: one browser process per file, not per test

Adding this ticket's tests (a second Chromium-launching test file,
alongside Ticket 3.1's) made the full suite noticeably more prone to
timeouts under `vitest`'s default parallel-file execution — confirmed
directly: the CPU-heavy 1,000-node layout test passed in ~7.5s total (the
whole file) in isolation, comfortably under its own 5s internal
assertion, but intermittently timed out only when the full suite ran
everything in parallel. Root-caused to each test individually launching
and tearing down its own Chromium process (`beforeEach`/`afterEach`) —
each launch is itself several OS processes, not one, and both browser-test
files were doing this on nearly every single test. Fixed at the source:
both files now launch **one** browser per file (`beforeAll`/`afterAll`),
reusing it across every test in that file (only a fresh `page`/temp
directory per test, both cheap). `vitest.config.ts`'s `testTimeout` and
`hookTimeout` were also both raised to 30s as headroom for genuine
scheduling contention under full-suite parallelism — confirmed this isn't
masking a real slowdown, only insuring against it.

## Alternatives Considered

**`d3-force` instead of `dagre`.** Rejected — the PRD itself recommends
`dagre` specifically because "directional/hierarchical clarity matters
more than aesthetics" for architecture diagrams, and `d3-force`'s organic/
physics-based layout doesn't produce the same readable, layered structure
for what's fundamentally a dependency graph.

**Baking layout into the Node build step (rejected — see above).**

**`dagre-d3`** (the layout-plus-rendering combo package). Rejected —
couples layout to d3's own DOM-manipulation/selection model, which this
project isn't using (custom SVG element creation instead, matching Ticket
3.1's precedent). Using bare `@dagrejs/dagre` for layout only and keeping
rendering fully custom avoids that coupling.

## Consequences

- `computeLayout()`'s generic, DOM-free contract means any future node/edge
  source (not just `RenderGraph`) can reuse it without modification — the
  caller is responsible for sizing nodes. (Update: this played out exactly
  as anticipated — see "Post-ship fixes from real usage" below, where
  switching from a heuristic to real DOM measurement only touched
  `app.ts`'s `sizeNode()`, nothing in `layout.ts`.)
- Client-side layout means the exported HTML's JS bundle includes `dagre`
  itself — a real, if modest, bundle-size cost every generated diagram
  pays, in exchange for Sprint 5's interactive re-layout working without
  rearchitecting.
- The SVG-snapshot visual-regression choice should be revisited if/when
  pixel-perfect fidelity actually matters (Sprint 8 export) — noted here
  so that's a deliberate reconsideration, not a forgotten gap.
- Every future browser-test file should default to one shared browser
  instance per file from the start, per the pattern established here —
  worth calling out in review for any new `*.test.ts` under `render/`.
