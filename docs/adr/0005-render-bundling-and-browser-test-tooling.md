# ADR 0005: Render bundling approach and headless-browser test tooling

**Status:** Accepted
**Date:** 2026-07-21
**Related:** Sprint 3, Ticket 3.1 (`src/render/build.ts`, `src/render/browser/`)

## Context

Ticket 3.1's objective is the packaging pipeline itself: inline JS/CSS into
one self-contained `index.html` with zero external requests, verified by
actually opening the result with the network disabled — not merely
inspecting the HTML text. This is the first ticket in the project that
produces browser-consumed code at all (Sprints 1–2 are pure Node/CLI), so
it introduces two genuinely new tooling decisions: how to bundle browser
code, and how to prove "no network calls" for real rather than by
inspection.

## Decision

### Bundler: `esbuild`

The PRD itself suggests `esbuild` (quoted directly in the ticket text).
Confirmed this is a sound choice independent of that suggestion: fast,
small, actively maintained, and its `define` option does exactly what's
needed here — replacing a source-level identifier with a literal JSON
value at bundle time, so the graph data ends up baked directly into the
JS bundle text rather than fetched separately at runtime. No plugin or
extra dependency needed for that; it's a built-in option.

**Inlining into the final HTML is a small custom step, not a plugin.**
`esbuild` bundles JS; it has no first-class "inline everything into one
HTML file" mode. Rather than reach for a community plugin (extra
dependency, extra surface to trust) for what's a ~15-line operation,
`render/build.ts` runs `esbuild.buildSync()` with `write: false` (get the
bundle as a string), reads `style.css` and `template.html` directly off
disk, and does a plain string replacement of two placeholder comments
(`/*__ARCHLENS_STYLE__*/`, `/*__ARCHLENS_SCRIPT__*/`). Using a *function*
replacer (`.replace(pattern, () => text)`) rather than a plain string
argument is deliberate, not incidental: `String.replace`'s string-argument
form interprets `$&`/`$1`-style sequences specially, and arbitrary bundled
JS/CSS could coincidentally contain a literal `$` followed by digits —
the function form treats the replacement as an opaque, literal string
regardless of its content.

### Headless-browser testing: `playwright` (not `@playwright/test`, not Puppeteer)

**Playwright over Puppeteer**: actively maintained by Microsoft, supports
network-request interception and `browser.newContext({ offline: true })`
directly — exactly what's needed to satisfy the ticket's own stated
verification method ("verify by opening with network disabled"), not
something bolted on.

**The plain `playwright` package, not `@playwright/test`**: the latter is
a full second test runner (its own `test()`/`expect()`, its own config,
its own CLI). Since this project already has `vitest` as its one test
runner across every other module, introducing a second one for just this
ticket would violate the "don't duplicate implementations" principle this
plan calls out elsewhere for *feature* code — the same reasoning extends
to test infrastructure. The plain `playwright` package exports
`chromium`/`firefox`/`webkit` launchers usable from any test framework, so
`build.test.ts` drives real Chromium from inside ordinary `vitest`
`describe`/`test` blocks — one test runner, one config, for the whole
project.

**`esbuild` is a runtime `dependency`, `playwright` is a `devDependency`.**
This distinction matters and was checked, not assumed: `render/build.ts`
runs at real CLI runtime (a real `npx archlens` user needs `esbuild`
installed to actually bundle their graph into HTML), while `playwright`
only drives the test suite — a published package's consumers never need
it. Confirmed via `npm install`'s placement, not just intent.

### Splitting Node-side and browser-side TypeScript compilation

`render/browser/app.ts` uses DOM globals (`document`, `HTMLElement`,
`SVGElement`) the main `tsconfig.json` doesn't have in its `lib` (Node
code has no business seeing DOM types, and vice versa). Rather than add
`"DOM"` to the main `lib` array (which would let *Node-side* code
accidentally reference `document` and not get caught until runtime), the
browser code gets its own `tsconfig.browser.json` (`lib: ["ES2022",
"DOM"]`, `noEmit: true` — type-checking only, since `esbuild` does the
actual bundling/transpilation), and the main `tsconfig.json`/
`tsconfig.build.json` both `exclude` `src/render/browser`.

**A real gotcha this surfaced**: TypeScript's `exclude` only controls
*root* file discovery via `include`'s globs — it does not stop a file
from being pulled into the same program if another *included* file
imports it. `render/build.ts` originally imported `DemoGraph` directly
from `render/browser/app.ts`, which silently dragged `app.ts` (and its
DOM usage) into the main Node-lib program via that import, failing
typecheck. Fixed by extracting the shared types with no DOM dependency
into their own file (`render/types.ts`), imported by both sides — `app.ts`
imports it as browser code, `build.ts` imports it as Node code, and
neither pulls the other's incompatible code into its own program. Caught
by actually running `tsc --noEmit` against both configs, not by reasoning
about it in the abstract.

ESLint needed the identical split (`@typescript-eslint/parser`'s
`project` option is program-specific the same way `tsc` is) — one
`eslint.config.js` block for `src/**/*.ts` (excluding `src/render/browser`,
pointed at `tsconfig.json`) and a second for `src/render/browser/**/*.ts`
(pointed at `tsconfig.browser.json`).

### Locating source assets from compiled Node code

`build.ts` (compiled to `dist/render/build.js`) needs `app.ts`/
`template.html`/`style.css` at runtime — none of which are ever compiled
by `tsc` into `dist/` (the `.html`/`.css` files aren't TypeScript at all;
`app.ts` is bundled by `esbuild` directly from its source, not from a
pre-compiled JS artifact). So the running code — whether it's
`src/render/build.ts` executing directly (vitest) or its compiled
`dist/render/build.js` counterpart — needs to reach back into `src/`.
This works reliably because `tsconfig.json`'s `rootDir`/`outDir` keep
`src/` and `dist/` mirrored at identical depth: a path computed relative
to *this file's own location* (`new URL('../../src/render/browser/',
import.meta.url)`) resolves to the same real directory in both cases,
verified directly (not assumed) by running the full test suite against
both the direct-`ts` and compiled-`dist` execution paths.

## Alternatives Considered

**webpack/rollup/parcel instead of esbuild.** Rejected — all three are
heavier (more config surface, slower) for a use case that's fundamentally
"bundle one small entry point and inline the result," which is squarely
esbuild's strength. No feature any of them offer (code-splitting, HMR,
complex loader chains) is needed here or anticipated for Ticket 3.2/3.3's
scope either.

**A community "html-inline" esbuild plugin.** Rejected — the actual
inlining operation is small and fully understood in-house; a plugin
dependency would trade a ~15-line function this project owns for a
transitive dependency this project would need to trust and track updates
for, with no real benefit at this scale.

**Puppeteer.** Rejected — Playwright's `offline` context option and
richer request-interception API map more directly onto this ticket's own
stated verification method than Puppeteer's equivalent (achievable, but
less first-class).

**`@playwright/test`.** Rejected — would introduce a second test runner
alongside `vitest` for one ticket's worth of tests; the plain `playwright`
package gives the same real-browser capability inside the existing runner.

## Consequences

- Two `tsconfig*.json` files and two `npm run typecheck` invocations going
  forward, not one — a real (small) ongoing cost, but the alternative
  (one `lib` array covering both Node and DOM globals) would let Node-side
  bugs (e.g. accidentally referencing `document`) pass typecheck and only
  fail at actual runtime.
- Any future browser-side module (Ticket 3.2's layout code, Ticket 3.3's
  detail panel) belongs under `src/render/browser/`, inheriting this same
  split automatically — no new configuration needed per file, only per
  new *directory* if the project ever wants finer-grained separation.
- `playwright`'s Chromium download (~300MB) is a real, if one-time, local
  setup cost (`npx playwright install chromium`) beyond `npm install`
  alone — worth calling out since it's new to this project's setup
  instructions (not yet automated in `npm install` itself; revisit if this
  becomes a friction point for other contributors).
