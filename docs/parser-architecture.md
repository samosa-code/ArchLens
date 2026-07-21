# Parser Architecture

Sprint 1's deliverable: turn one or more CloudFormation template files on
disk into a tree of resolved values — every `Ref`, `Fn::GetAtt`, and their
relatives substituted with what they actually point to wherever that's
statically determinable, and every resource's existence resolved against
its `Conditions`. This document explains that pipeline end to end,
consolidating what Tickets 1.1–1.6 each documented piecemeal. It's the
single doc to read to understand the parser; `docs/developer-guide.md`
indexes it alongside future modules, and the ADRs and `LIMITATIONS.md`
referenced throughout are the detail-and-decision records this document
points to rather than duplicates.

**See it run:** `npm run demo` (or `npm run demo -- "path/to/*.yaml"` for a
specific glob) builds the project and runs `src/cli.ts`. As of Ticket 2.4,
this prints a merged-graph summary (node/edge counts, resolved and
unresolved cross-stack references — see
[`docs/graph-architecture.md`](graph-architecture.md)) rather than a
single template's raw resolved JSON, since `cli.ts` now exercises the full
Sprint 1 + Sprint 2 pipeline (`mergeGraphs()`), not just this parser stage
in isolation. The parser stage documented below is still exactly what runs
underneath — `mergeGraphs()` calls `buildGraph()` calls this module — this
document remains the accurate reference for that stage specifically. Sprint
3 (Ticket 3.4) builds the actual `npx archlens <glob> --out <dir>` CLI
(flags, HTML rendering) on top of this same file rather than replacing it.

## Pipeline overview

```
Template file(s) on disk
     │
     ▼
loadTemplates(filePaths)              parser/loader.ts — Tickets 1.1, 1.6
  └─ loadTemplate(file) per file        format detection (.yaml/.yml vs .json)
       ├─ succeeds → AstNode            YAML: `yaml` package + short-form tag
       └─ throws   → warning, skip        normalization to CFN long-form
                                         JSON: `jsonc-parser`, strict (no
                                           trailing commas/comments)
     │                                 Every node carries {file, line, column}
     ▼
buildResolutionContext(template)      parser/intrinsics.ts — Ticket 1.2
  parameters, resources, mappings       Walks Parameters/Resources/Mappings
  (conditions: empty Map)               once per template
     │
     ▼
evaluateConditions(template, context) parser/conditions.ts — Ticket 1.5
  → Map<name, ConditionValue>           Only needed if the template uses
     │                                  Fn::If or Condition attributes
     ▼ (merge into context.conditions)
resolveValue(propertyNode, context)   parser/intrinsics.ts — Tickets
  → ResolvedValue                       1.2, 1.3, 1.4, 1.5
     Recursively resolves Ref, Fn::GetAtt, Fn::Join, Fn::Select, Fn::Sub,
     Fn::FindInMap, Fn::ImportValue (stub), Fn::If — to arbitrary nesting
     depth — leaving anything unresolvable explicitly flagged, never guessed.
     │
     ▼
  Ready for Sprint 2: resourceRef/attributeRef become graph edges,
  importValueRef becomes a cross-stack merge candidate, unresolved/unknown
  surfaces in the UI rather than being silently dropped.
```

Despite the diagram's straight line, `evaluateConditions` isn't just
another step after context-building finishes — it *consumes* the context
`buildResolutionContext` produces (to resolve `Fn::Equals` operands via
`resolveValue`), and its own output then needs merging back into that same
context before `Fn::If` can resolve. See "Why conditions is a separate
module" below for exactly what that dependency looks like and why it only
goes one direction.

## Module map

| Module | Ticket(s) | Responsibility |
|---|---|---|
| `parser/loader.ts` | 1.1, 1.6 | File → `AstNode`, single- and multi-file |
| `parser/getAttShorthand.ts` | 1.1 | Shared `Fn::GetAtt` dotted-string splitting (loader's `!GetAtt` tag normalization and `intrinsics.ts`'s `Fn::GetAtt` resolver both use it) |
| `parser/intrinsics.ts` | 1.2, 1.3, 1.4, 1.5 (`Fn::If`) | `AstNode` property value → `ResolvedValue` |
| `parser/conditions.ts` | 1.5 | `Conditions` block → per-name `ConditionValue`; per-resource inclusion |
| `common/types.ts` | all | `AstNode`, `ResolvedValue`, `ConditionValue`, `ResourceInclusion` |
| `common/interfaces.ts` | all | `SourcePosition`, `AstEntry`, `ResolutionContext`, `LoadTemplatesResult` and friends |

## Stage 1: Loading

**Single file — `loadTemplate(filePath)`.** Dispatches on file extension:
`.json` goes through `jsonc-parser`'s `parseTree()` in strict mode
(`allowTrailingComma: false, disallowComments: true` — CFN's JSON has
neither, unlike the general-purpose JSONC files that library is usually
used for); everything else goes through the `yaml` package's
`parseDocument()`. Both code paths convert down to the same `AstNode`
shape (`object` / `array` / `scalar`, each carrying a `SourcePosition`),
so nothing downstream needs to know which format a template was written
in — verified directly: `examples/01-simple-lambda`'s YAML and JSON
versions of the same template produce an equal `AstNode` tree (position
metadata aside), confirmed at the loader level before any intrinsic
resolution happens.

Both parser libraries only expose character *offsets*, not line/column.
Rather than trust two libraries' potentially different offset→position
conventions, both paths funnel through one shared `offsetToPosition()`,
so a YAML template and a JSON template use identical position semantics.

**YAML short-form tag normalization.** Real-world CFN YAML uses `!Ref`,
`!GetAtt`, `!Sub`, etc. pervasively — the loader normalizes all of them
(`SHORT_FORM_TAGS` in `loader.ts`: `Ref`, `Condition`, `Fn::GetAtt`,
`Fn::Sub`, `Fn::Join`, `Fn::Select`, `Fn::Split`, `Fn::FindInMap`,
`Fn::Base64`, `Fn::Cidr`, `Fn::ImportValue`, `Fn::GetAZs`, `Fn::If`,
`Fn::Not`, `Fn::Equals`, `Fn::And`, `Fn::Or`, `Fn::Transform`) to the same
long-form object shape (`{Ref: X}`, `{"Fn::GetAtt": [...]}`, ...) that
JSON templates always use — this is what makes "YAML and JSON produce the
same AST" actually true rather than aspirational. `Fn::GetAtt`'s shorthand
additionally changes *shape* (a dotted string → a 2-element array), not
just its key, so it's handled as a special case via
`getAttShorthand.ts`'s `splitGetAttShorthand()` (also reused by
`intrinsics.ts`'s `Fn::GetAtt` resolver for its own dotted-string-form
argument). `Fn::Sub`'s implicit-`GetAtt` placeholder handling
(`${Resource.Attr}`) does its own inline first-dot split rather than
calling `splitGetAttShorthand()` — a minor duplication worth cleaning up
later — but does share `attributeRefOrUnresolved()`, the "is this
resource actually declared" check, with the real `Fn::GetAtt` resolver,
so the two can't disagree about *whether* a `GetAtt`-style reference is
valid, even though the splitting itself isn't literally shared code.

**Multi-file — `loadTemplates(filePaths)`.** Never throws itself: loads
each file independently via `loadTemplate`, catching per-file failures
into a `warnings` array (`{file, message}`) rather than aborting the
whole run (PO Question 3). A file with valid syntax but a semantically
broken reference (e.g. `Fn::GetAtt` to an undeclared resource) is *not* a
load failure — it loads normally and the specific broken reference
surfaces later as an explicit `unresolved` result when that property is
resolved, not as a warning here. Verified against
`examples/05-malformed-and-missing-ref/`: `invalid-yaml.yaml` (genuine
YAML syntax error) produces a warning and is excluded from the result;
`missing-resource-ref.yaml` (valid YAML, dangling `GetAtt`) loads
successfully alongside it.

**Decision record:** why `yaml` and `jsonc-parser` specifically (and why
not the more obvious `js-yaml` / `json-to-ast`) is
[ADR 0001](adr/0001-yaml-json-parser-choice.md), including the
alternatives considered and why one candidate was rejected for being
unmaintained since 2022.

## Stage 2: Intrinsic function resolution

**Module:** `parser/intrinsics.ts`. **Entry points:**

```ts
const context = buildResolutionContext(templateAst); // once per template
const resolved = resolveValue(somePropertyNode, context); // once per property
```

`buildResolutionContext` walks `Parameters` (name → `Default` AstNode, or
`undefined`), `Resources` (the set of declared logical IDs), and
`Mappings` (name → definition AstNode) once. `context.conditions` starts
as an empty `Map` — see Stage 3 for how it gets populated.

`resolveValue` is a recursive walker, not a single-shot function — called
on *any* AstNode, not just intrinsic calls. It dispatches to a
function-specific resolver for a recognized single-key object
(`Ref`, `Fn::GetAtt`, `Fn::Join`, `Fn::Select`, `Fn::Sub`, `Fn::FindInMap`,
`Fn::ImportValue`, `Fn::If`), and otherwise recurses through plain
scalars/arrays/objects unchanged — including objects using an intrinsic
*not yet implemented* (e.g. `Fn::Base64`), whose nested content still
resolves correctly rather than the whole subtree giving up. This
recursive-by-default design is what makes arbitrary nesting depth work
without special-casing it (Ticket 1.4) — verified with a dedicated fixture
resolving 4 levels deep (`Fn::Select` → `Fn::Join` → `[Fn::FindInMap,
Fn::GetAtt]`) and a fully-static 3-level case that collapses all the way
to one plain string.

### The result shape: `ResolvedValue`

| Kind | Meaning |
|---|---|
| `scalar` | A fully known literal — either it was one already, or an intrinsic computed one. |
| `list` / `object` | Structural pass-through of a plain array/object, each element/entry itself resolved. |
| `resourceRef` | `Ref` to a declared `Resources` entry — deliberately not collapsed further (a resource's physical ID doesn't exist until deploy time); the reference edge the graph model (Sprint 2) builds on. |
| `attributeRef` | `Fn::GetAtt`, same reasoning, plus which attribute. |
| `parameterRef` | `Ref` to a declared `Parameters` entry with no statically-known `Default`. |
| `pseudoParameterRef` | `Ref` to an `AWS::*` pseudo parameter — always deploy-time-unknown, detected generically by prefix. |
| `importValueRef` | `Fn::ImportValue`, tagged but not resolved — see below. |
| `availabilityZonesRef` | `Fn::GetAZs` — the AZ list for `region`, never resolved to actual names (deploy-time *and* account-specific). |
| `availabilityZoneRef` | `Fn::Select` over an `availabilityZonesRef` with a static index — one specific AZ by position, name still unknown. |
| `unresolved` | Genuinely undeterminable, always with a human-readable `reason`. Never silently guessed. |

### Per-function behavior

- **`Ref`** — pseudo parameter (`AWS::` prefix) → declared parameter
  (resolved `Default`, or `parameterRef` if none — no `--parameters` file
  in v1, PO Question 2) → declared resource (`resourceRef`) → otherwise
  `unresolved`.
- **`Fn::GetAtt`** — accepts both the 2-element array form and the dotted-
  string long-form (independent of the `!GetAtt` tag). Only the *first*
  dot splits resource from attribute (`Nested.Outputs.Value` →
  `["Nested", "Outputs.Value"]`), since the attribute name may itself
  contain dots.
- **`Fn::Join`** — collapses to one `scalar` string only if the delimiter
  and every part are literal; otherwise falls back to a `list` of the
  resolved parts so nested references stay visible rather than being
  hidden inside an opaque `unresolved`. A non-literal *delimiter* is
  stricter and does resolve to `unresolved`.
- **`Fn::Select`** — only the *index* needs to be static; the selected
  item resolves however it resolves (literal or reference) regardless of
  whether the list's other items are static. Out-of-bounds and
  non-numeric/dynamic indices resolve to `unresolved`. If the list argument
  isn't a literal AST array, it's resolved first: an `availabilityZonesRef`
  (from `Fn::GetAZs`) becomes an `availabilityZoneRef` at the given index
  — the extremely common `!Select [N, !GetAZs region]` idiom, confirmed in
  13 of 67 fixtures during a real-world stress test (see
  `LIMITATIONS.md`'s "Real-world stress test" section) — and a resolved
  `list` (most commonly from `Fn::Split`) is selected from directly.
- **`Fn::GetAZs`** — resolves its region argument (any shape) and wraps the
  result as `{kind: 'availabilityZonesRef', region}`. Never resolves to
  actual zone names — which zones exist and are enabled is deploy-time
  *and* AWS-account-specific, the same reasoning `pseudoParameterRef`
  already applies elsewhere.
- **`Fn::Split`** — unlike `Fn::GetAZs`, a pure string operation: computes
  the actual split into a `list` of literal scalars when both the
  delimiter and source string are literal; resolves to `unresolved`
  (naming which argument failed) otherwise. Common real pattern:
  `!Select [0, !Split ["=", !Ref Tag]]` for parsing a `"key=value"`
  parameter — resolves fully when `Tag` has a literal `Default`, stays
  correctly `unresolved` when it doesn't.
- **`Fn::Sub`** — both short form (bare string) and long form
  (`[template, {Name: value}]`, whose substitution values may be any
  intrinsic). Each `${...}` placeholder resolves via: the explicit
  substitution map, then implicit `Fn::GetAtt` (dotted name), then
  implicit `Ref` — reusing `resolveRef`/`attributeRefOrUnresolved`
  directly so these can never disagree with a literal `Ref`/`Fn::GetAtt`.
  `${!Name}` is CFN's escape for a literal `${Name}`. Same collapse-or-
  fall-back-to-list behavior as `Fn::Join`.
- **`Fn::FindInMap`** — all three arguments (`[mapName, topLevelKey,
  secondLevelKey]`) must resolve to literal strings. A dynamic key (most
  commonly `!Ref AWS::Region`) resolves to `unresolved` rather than
  guessing. Verified against a real fixture: `examples/02-complex-vpc-nat`'s
  `!FindInMap [SubnetConfig, VPC, CIDR]` resolves to the literal
  `10.0.0.0/16`.
- **`Fn::ImportValue`** — never resolves an actual cross-stack *value* in
  Sprint 1 (that needs Sprint 2's multi-stack merge); always returns
  `{kind: 'importValueRef', exportName}`, where `exportName` is the
  argument resolved as far as possible (a `Fn::Join`-composed export name
  — the common real-world pattern, see `examples/03-multi-stack-ecs-fargate`
  — collapses to one literal string when its inputs are static, so Sprint 2
  gets a ready-to-match value instead of raw AST).
- **`Fn::If`** — see Stage 3; it's the one intrinsic whose resolution
  depends on `conditions.ts`'s output rather than only `intrinsics.ts`'s
  own context fields.
- **`Fn::GetStackOutput`** — recognized but always resolves to `unresolved`
  (PO Question 4e, Sprint 2). Unlike a genuinely-unimplemented intrinsic
  (e.g. `Fn::Base64`, which passes through unchanged), this one is
  explicitly flagged, since it represents a real cross-stack reference that
  would otherwise be silently misrepresented as an opaque plain object. See
  `LIMITATIONS.md` for why full resolution isn't implemented.

## Stage 3: Conditions evaluation

**Module:** `parser/conditions.ts`. Covers the `Conditions` block itself,
per-resource `Condition` attributes, and the condition-expression
functions `Fn::Equals`, `Fn::Not`, `Fn::And`, `Fn::Or`, and `Condition`
(the condition-reference function — no `Fn::` prefix, the same special
case as `Ref`).

### Why a separate module from `intrinsics.ts`

A `Conditions` block entry decides whether a *resource exists at all*,
and the same evaluated result is what `Fn::If` (a *property*-level
intrinsic) reads to pick a branch — both need one evaluator, so it lives
in one place. But the dependency only goes one direction: evaluating
`Fn::Equals` needs `resolveValue()` to resolve its operands, so
`conditions.ts` imports from `intrinsics.ts`. The reverse — `intrinsics.ts`
importing `conditions.ts` so `buildResolutionContext()` could populate
`conditions` automatically — would be circular. So `ResolutionContext.
conditions` is just a plain `Map` (empty by default), and any caller that
needs `Fn::If` to actually resolve does the two-step explicitly:

```ts
const context = buildResolutionContext(template);          // conditions: empty
const conditionResults = evaluateConditions(template, context);
const fullContext = { ...context, conditions: conditionResults };
```

### Three-valued logic

A `ConditionValue` is `true`, `false`, or `unknown` (with a reason) —
never a plain boolean, since a condition depending on a parameter with no
`Default`, or on an `AWS::*` pseudo parameter, is genuinely undeterminable
from the template alone (PO Question 1's "never silently guessed"
extended from resources to conditions themselves). `Fn::And`/`Fn::Or`
short-circuit on the *decisive* value under this three-valued logic, not
just "all inputs known": `Fn::And` is `false` if any operand is `false`,
even if another is `unknown`; symmetrically `Fn::Or` is `true` if any
operand is `true`. Only when no operand is decisive does the result
become `unknown`. `Condition` references are evaluated lazily and
memoized, and a circular reference (`A` → `B` → `A`) resolves to `unknown`
rather than infinite-looping.

### Resource inclusion and `Fn::If`

`resourceInclusion(resourceNode, conditionResults)` maps a resource's
`Condition` attribute (absent → always `included`) through the named
condition's `ConditionValue`: `true` → `included`, `false` → `excluded`,
`unknown` → `unknown` — PO Question 1's distinct "unknown/conditional"
outcome, carried through with its reason. `Fn::If` mirrors the same
stance at the property level: an unresolvable or undefined condition
resolves it to `unresolved`, never a guessed branch.

Verified end-to-end against a real fixture:
`examples/03-multi-stack-ecs-fargate`'s `HasCustomRole: !Not [!Equals
[!Ref Role, ""]]` evaluates to `false` (`Role`'s `Default` is `""`), and
the `Fn::If` depending on it (`TaskRoleArn: !If [HasCustomRole, !Ref Role,
!Ref AWS::NoValue]`) correctly resolves to the `AWS::NoValue` branch.

## Cross-cutting design principles

These recur across every stage above, deliberately, not by accident:

- **Never silently guess.** Every stage's "I don't know" case is a
  distinct, explicit result (`unresolved`, `parameterRef`,
  `pseudoParameterRef`, `unknown`) carrying a reason, never a fallback to
  a plausible-looking default. This traces directly to the Sprint 1
  Product Owner decisions (Questions 1–3) made before any parser code was
  written.
- **Keep partial information, don't collapse to "unresolved."** `Fn::Join`,
  `Fn::Sub`, and `Fn::Select` all preserve whatever nested references they
  can when they can't fully collapse to a literal, rather than discarding
  everything the moment one part isn't static.
- **Validate against real templates, not just synthetic fixtures.** Every
  stage above has at least one test against an unmodified real-world
  template from `examples/` (sourced from AWS's own sample repos), not
  only hand-written fixtures — this caught real bugs during development
  (e.g. YAML short-form tags not normalizing before real-world
  YAML/JSON-equivalence tests were added in Ticket 1.1).
- **Share an implementation instead of duplicating logic that must agree.**
  Offset→position conversion and `Fn::GetAtt` dotted-string splitting each
  exist in exactly one place and are reused across modules
  (`offsetToPosition` by both the YAML and JSON loading paths;
  `splitGetAttShorthand` by both the loader's `!GetAtt` tag normalization
  and `intrinsics.ts`'s `Fn::GetAtt` resolver) specifically because having
  two independent copies would risk them silently disagreeing. Note this
  isn't absolute — see the `Fn::Sub` note above for one place a second
  inline implementation crept in anyway. Similarly,
  `conditions.ts`'s condition-expression dispatch and
  `intrinsics.ts`'s `resolveValue` dispatch are structurally similar
  (both switch on a single-key object's key) but are separate
  implementations, since they dispatch to different function sets for
  different purposes.

## Architecture review: extensibility for Sprint 2's cross-stack resolver

Sprint 1's own plan calls for confirming, before Sprint 2 starts, that the
resolver can accept a "pending cross-stack reference" concept cleanly.
This section is that review's record — what was checked, what it found,
and what Sprint 2 should design around rather than assume.

**What was checked:** every place in `intrinsics.ts` and `conditions.ts`
that pattern-matches on a `ResolvedValue`'s `kind` (27 occurrences,
grepped directly rather than assumed). None of them `switch` exhaustively
over every possible kind — each checks only the specific kind it cares
about (`value.kind === 'scalar'`, `operand.kind === 'true'`, etc.). This
means adding a new `ResolvedValue` variant is purely additive: one new
member in the `common/types.ts` union, zero changes required anywhere in
Sprint 1's code, and nothing breaks. Concretely verified: `Fn::Join`/
`Fn::Sub`'s `.every(isScalarResolved)` collapse check would correctly
treat any brand-new non-scalar kind as "doesn't collapse" — exactly the
right behavior — without modification.

**Conclusion: the handoff shape is sound.** `{kind: 'importValueRef',
exportName: ResolvedValue}` already carries what Sprint 2's Ticket 2.3
needs — an export-name expression resolved as far as statically possible,
not raw AST to re-walk. This is validated against real data, not just
designed in the abstract: `examples/03-multi-stack-ecs-fargate`'s
`Fn::Join`-composed export name collapses to the literal string
`"production:ECSTaskExecutionRole"`, a ready-to-match value.

**Two things Sprint 2 should design around, not assume:**

1. **`ResolvedValue` carries no source position, by design** (see its
   type doc comment — a resolved value may combine pieces from several
   source locations, so no single position would be meaningful). This
   means an `importValueRef` alone can't tell Sprint 2 which template
   file or which resource/property it came from. That's fine *as long as*
   Sprint 2's graph-building orchestration tracks that context at the
   call site — it already knows which resource/property it's resolving
   when it calls `resolveValue()`, so it should carry that alongside the
   result rather than expect to recover it from the `ResolvedValue` tree
   after the fact.
2. **A non-scalar `exportName` and a scalar `exportName` with no matching
   export are two different failure modes, not one.** The former means
   the *name itself* wasn't statically determinable (Sprint 1's concern,
   already flagged via a `list`/`unresolved` `exportName` rather than a
   plain string); the latter means the name was fully known but Sprint
   2's symbol table (Ticket 2.2) has no matching `Export.Name` for it
   (Sprint 2's concern, per PO Question 4 — flagged, not silently
   dropped). Conflating these into one "unresolvable import" message
   would lose real diagnostic value — "we couldn't tell what you were
   importing" and "we know what you wanted but it doesn't exist" call for
   different troubleshooting steps.

No code changes came out of this review — the design already supports
the handoff cleanly. Extending the union when Sprint 2 needs to (e.g. a
`crossStackRef` kind once an import is actually matched) is expected and
normal, not a sign the design was incomplete; TypeScript discriminated
unions aren't extended without touching their declaration, and one line
in `common/types.ts` is the right amount of friction for that.

## What's explicitly out of scope for Sprint 1

See [`LIMITATIONS.md`](../LIMITATIONS.md) for the complete, current list
(kept up to date there, not duplicated here). Headline items: no
`--parameters` file, several intrinsics still have no resolver at all
(`Fn::Base64`, `Fn::Cidr`, `Fn::Transform`, `Fn::ForEach` — `Fn::GetAZs`
and `Fn::Split` *were* on this list until a Sprint 2 real-world stress
test found them in active use and both were implemented), YAML
anchors/aliases aren't supported by the loader, and malformed-template
handling is skip-and-warn at the multi-file level only (a single
`loadTemplate` call still throws). `Fn::ImportValue` resolving an actual
cross-stack value is Sprint 2's concern, not Sprint 1's — see
[`docs/graph-architecture.md`](graph-architecture.md), which is complete
as of Ticket 2.4.

## Related documents

- [ADR 0001: YAML and JSON parser choice](adr/0001-yaml-json-parser-choice.md)
- [`LIMITATIONS.md`](../LIMITATIONS.md) — current, authoritative gaps list
- [`docs/developer-guide.md`](developer-guide.md) — project-wide doc index across all sprints
