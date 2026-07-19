# ADR 0001: YAML and JSON parser choice for the template loader

**Status:** Accepted
**Date:** 2026-07-19
**Related:** Sprint 1, Ticket 1.1 (`src/parser/loader.ts`)

## Context

Ticket 1.1 requires loading a CloudFormation template (YAML or JSON) into a
normalized AST where **every node carries its source position**
(`{file, line, column}`), needed later for click-to-source navigation
(Sprint 4). The acceptance criteria also require that a YAML template and a
JSON template covering the same resources produce an **equivalent** AST.

This means the parser choice for each format had to satisfy:
1. Exposes per-node source position (not just "parse succeeded/failed").
2. Actively maintained — this is a foundational dependency every later
   sprint builds on.
3. Strict enough to reject malformed input rather than silently repairing it
   (CFN JSON in particular has no tolerance for trailing commas or comments).

## Decision

- **YAML:** [`yaml`](https://www.npmjs.com/package/yaml) (eemeli/yaml), via
  `parseDocument()`.
- **JSON:** [`jsonc-parser`](https://www.npmjs.com/package/jsonc-parser)
  (Microsoft/VS Code), via `parseTree()` with `{ allowTrailingComma: false,
  disallowComments: true }` to make it strict-JSON rather than JSONC.

Both libraries expose only **character offsets** (`range`/`offset`), not
line/column directly. Rather than trust each library's own offset→line/col
convention (which could differ subtly between the two), the loader
implements a single shared `offsetToPosition()` and routes both formats
through it. This makes the "equivalent AST" requirement literally
verifiable — positions from either format are computed identically, not
just structurally similar.

CloudFormation's YAML short-form intrinsic tags (`!Ref`, `!GetAtt`, `!Sub`,
`!If`, ...) are normalized at load time to the same long-form object shape
JSON always uses (`!Ref Foo` → `{Ref: Foo}`), since real-world CFN YAML
uses these tags pervasively and the AST would otherwise not be equivalent
between formats for any realistic template (caught by testing against the
real `examples/01-simple-lambda/template.yaml` fixture, not a synthetic
one — see Alternatives Considered below on why real fixtures mattered).
`!GetAtt`'s shorthand (`Resource.Attr`) additionally changes shape (dotted
string → `[Resource, Attr]` array), handled as a special case since it's
the one short-form tag whose *content*, not just its key, differs from
long-form.

## Alternatives Considered

**YAML: `js-yaml`.** The more commonly-reached-for YAML library. Rejected —
it does not expose per-node source ranges in its parsed output by default
(position data exists only transiently during parsing, surfaced in error
messages, not on the resulting JS object tree). Would have required either
forking its walk logic or a second pass to recover positions, for no
benefit over `yaml`, which supports this natively via its CST/Document API.

**JSON: `json-to-ast`.** Directly produces a node tree with
`loc: {start: {line, column, offset}}` on every node — superficially the
closest match to what Ticket 1.1 asks for, and initially selected for that
reason. Rejected after checking npm metadata: last published 2022-06-19
(unmaintained for 4 years as of this writing). Given this dependency is
foundational — every later sprint reads through the AST this loader
produces — an actively-maintained library (`jsonc-parser`, published days
before this decision, maintained by the VS Code team) was worth the small
extra cost of writing our own offset→position conversion instead of
getting line/column for free.

**JSON: hand-rolled parser.** Rejected as unnecessary — `jsonc-parser`'s
`parseTree()` already gives exactly the AST-with-offsets shape needed;
writing a bespoke JSON parser would duplicate well-tested logic (string
escaping, number parsing, Unicode) for no gain.

## Consequences

- Two different parser libraries with two different position
  representations (offsets) are unified through one shared conversion
  function — a later change to position semantics (e.g. 0-indexing) only
  needs to happen in one place.
- `!GetAtt` dotted-shorthand splitting only breaks on the *first* dot. This
  matches AWS's documented behavior (the attribute name itself may contain
  dots, e.g. nested stack outputs) but is worth flagging since it's easy to
  get backwards.
- YAML anchors/aliases (`&anchor` / `*ref`) are not yet supported — the
  loader throws an explicit "not yet supported" error rather than silently
  mishandling them. Not required by any Sprint 1 ticket; real CFN templates
  rarely use them, but this is a known gap, not a silent one.
- `Fn::ForEach` (CloudFormation's newer template language extension, with a
  dynamic tag suffix like `!ForEach::Name`) is out of scope — it doesn't
  fit the fixed short-form-tag lookup table used here. Not required by any
  Sprint 1 fixture or ticket.
