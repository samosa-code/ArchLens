# Developer Guide

Living documentation of how ArchLens's internals work, written as each
piece is built. Sections are added ticket by ticket (see the sprint plan)
and consolidated here rather than scattered across PR descriptions.

## How intrinsic function resolution works

**Module:** `src/parser/intrinsics.ts`
**Covers:** `Ref`, `Fn::GetAtt`, `Fn::Join`, `Fn::Select` (Sprint 1, Ticket 1.2)

### The problem

`parser/loader.ts` (Ticket 1.1) parses a template into an `AstNode` tree
that still mirrors the source syntax exactly — a property like
`Role: !GetAtt LambdaRole.Arn` becomes an AST node shaped like
`{Fn::GetAtt: [LambdaRole, Arn]}`, but nothing has looked up what
`LambdaRole` *is* yet. The intrinsic resolver is the layer that does that
lookup: given a template's `Parameters`/`Resources`/`Mappings`, it walks a
property value and substitutes each intrinsic function call with what it
actually resolves to, wherever that's statically determinable from the
template alone (no AWS credentials, no deploy-time values — consistent
with the PRD's static-analysis-only scope).

### The two entry points

```ts
import { buildResolutionContext, resolveValue } from './parser/intrinsics.js';

const context = buildResolutionContext(templateAst); // once per template
const resolved = resolveValue(somePropertyNode, context); // once per property
```

`buildResolutionContext` walks the top-level `Parameters`, `Resources`, and
`Mappings` sections once, producing a `ResolutionContext`:

| Field | Contents |
|---|---|
| `parameters` | name → its `Default` AstNode, or `undefined` if it has none |
| `resources` | the set of declared logical IDs (existence checks for `Ref`/`Fn::GetAtt`) |
| `mappings` | name → definition AstNode — stored but **not consumed by this ticket's four functions**; here so `Fn::FindInMap` (Ticket 1.3) can reuse the same context without a second AST walk |

`resolveValue` is the recursive walker. Called on *any* AstNode — not just
ones that happen to be intrinsic calls — it either dispatches to a
function-specific resolver (see below) or, for ordinary structure (plain
scalars, arrays, objects that aren't a recognized `Fn::*`/`Ref` call),
recurses through unchanged, just resolving whatever intrinsics turn up
inside it. This means you can call `resolveValue` on a whole `Properties`
block and get back the same shape with every intrinsic substituted,
without needing to know in advance where in that block an intrinsic
appears.

### The result shape: `ResolvedValue`

Defined in `src/common/types.ts`. Every resolution produces one of:

| Kind | Meaning |
|---|---|
| `scalar` | A fully known literal — either it was one already, or an intrinsic computed one (e.g. a fully-static `Fn::Join`). |
| `list` / `object` | Structural pass-through of a plain array/object, with each element/entry itself resolved. |
| `resourceRef` | `Ref` to a declared `Resources` entry. This is deliberately **not** collapsed further — a resource's physical ID doesn't exist until deploy time. This is the "reference edge" the graph model (Sprint 2) builds on. |
| `attributeRef` | `Fn::GetAtt`, same deploy-time-unknown reasoning as `resourceRef`, plus which attribute. |
| `parameterRef` | `Ref` to a declared `Parameters` entry with no statically-known `Default`. |
| `pseudoParameterRef` | `Ref` to an `AWS::*` pseudo parameter (`AWS::Region`, `AWS::AccountId`, `AWS::NoValue`, ...) — always deploy-time-unknown, detected generically by the `AWS::` prefix rather than an exhaustive hardcoded list. |
| `unresolved` | Genuinely undeterminable — undefined name, malformed arguments, dynamic index — always carries a human-readable `reason`. Never silently guessed, per the project's established graceful-degradation stance (see Sprint 1's PO Q1–3 decisions). |

### Per-function notes

**`Ref`** — dispatch order is: pseudo parameter (`AWS::` prefix) → declared
parameter (return its resolved `Default`, or a `parameterRef` if it has
none — no `--parameters` file support in v1, [ADR 0001](adr/0001-yaml-json-parser-choice.md)'s
sibling decision from Sprint 1 planning) → declared resource
(`resourceRef`) → otherwise `unresolved`.

**`Fn::GetAtt`** — accepts *both* valid CFN forms: the 2-element array
(`[LogicalId, Attr]`) and the dotted string (`"LogicalId.Attr"`, valid CFN
long-form syntax independent of the `!GetAtt` YAML tag shorthand that
`loader.ts` already normalizes — see `getAttShorthand.ts`, shared between
both modules). Only the *first* dot splits resource from attribute, since
the attribute name may itself contain dots (a nested stack output like
`Nested.Outputs.Value` splits into `["Nested", "Outputs.Value"]`).

**`Fn::Join`** — collapses to a real `scalar` string only when the
delimiter *and every part* resolve to a literal. If any part is a
reference (e.g. `!Join ["-", [!Ref Vpc, "subnet"]]`), the whole call can't
become a single string — but rather than give up and return `unresolved`
(which would hide the `Ref` to `Vpc` from anything looking for reference
edges), it falls back to a `list` of the resolved parts. A non-literal
*delimiter* is treated more strictly and does resolve to `unresolved`,
since a join without a known separator isn't useful even partially.

**`Fn::Select`** — only the *index* needs to be static; the list's other
items don't. `!Select [0, [!Ref A, "b"]]` resolves to whatever item 0
resolves to (here, `A`'s `resourceRef`) regardless of item 1 not being
literal. Out-of-bounds and non-numeric/dynamic indices both resolve to
`unresolved` with a specific reason.

### Known limitations (by design, not oversight)

- **`Fn::Sub`, `Fn::FindInMap`, `Fn::ImportValue`, `Fn::If` and friends are
  not yet handled** — they fall through to the generic object pass-through,
  which is harmless (nothing crashes) but also doesn't resolve them. That's
  Ticket 1.3 (and Conditions, Ticket 1.5).
- **`AWS::NoValue`** is treated like any other pseudo parameter
  (`pseudoParameterRef`). Its special "remove this property from the
  parent" semantic is a property-application concern, not a value-resolution
  one, and isn't implemented yet.
- **YAML anchors/aliases** aren't supported by the loader this resolver
  builds on (see ADR 0001) — a template using them fails at the loading
  stage, before the resolver ever sees it.
