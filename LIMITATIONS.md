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
  `Fn::Split`, `Fn::GetAZs`, `Fn::Transform`, and the newer `Fn::ForEach`
  template language extension. None are required by any Sprint 1 ticket.
  Property values using them pass through structurally unchanged (nested
  intrinsics inside them still resolve) rather than erroring.
