# ADR 0003: Export symbol table — assumed stack name and pseudo-parameter matching strategy

**Status:** Accepted
**Date:** 2026-07-20
**Related:** Sprint 2, Ticket 2.2 (`src/graph/exports.ts`, `src/graph/stackName.ts`)

## Context

Ticket 2.2 builds a lookup table mapping `Export.Name` → source template +
value, across N parsed templates. PO Question 4b (decided during Ticket
2.1) already established the headline decision — pseudo parameters inside
export names get a default, per-file "assumed" value rather than staying
permanently unresolvable — but its text didn't pin down two things that
only became visible once real fixtures were inspected during this ticket's
implementation:

1. *Which* per-file signal (filename vs. containing folder) `AWS::StackName`
   should assume.
2. What non-`StackName` pseudo parameters (`AWS::Region` et al.) should
   assume, since "per-file convention" doesn't make sense for them — no
   file path tells you what region it deploys to.

Both were resolved with the user before writing code, the same as every
other genuine design fork this project has hit (PO Questions 4d, 4e).

## Decision

### `assumedStackName(file)`: filename, unless it's generic — then the folder

Real fixtures need *both* rules, not one universal rule:

- `examples/03-multi-stack-ecs-fargate/{network-stack,service-stack,
  private-subnet-public-service}/template.yaml` — all three literally named
  `template.yaml`. Only the containing folder distinguishes them.
- `examples/06-nested-stack-quickstart/{root,bastion-child,vpc-child}
  .template.yaml` — all three in the same folder. Only the filename
  distinguishes them.

`assumedStackName()` (`src/graph/stackName.ts`) strips the extension and a
trailing `.template` suffix (`root.template.yaml` → `root`); if what
remains is the generic word `template` (case-insensitively), it falls back
to the containing folder's name instead of using the indistinct filename.
Verified against both real layouts directly — see `stackName.test.ts` for
the "two files, same generic stem, different folders → different names"
and "two files, same folder, distinct stems → different names" cases,
both of which would fail under either single-rule alternative.

### Every other pseudo parameter: one fixed global placeholder, not per-file

`AWS::Region`, `AWS::AccountId`, `AWS::Partition`, `AWS::URLSuffix`, and
`AWS::StackId` each resolve to one constant assumed string
(`ASSUMED_PSEUDO_PARAMETER_PLACEHOLDERS` in `graph/exports.ts`), the same
value regardless of which template file is being processed — unlike
`AWS::StackName`, there is no per-file signal to derive a distinct value
from, and these values are normally shared across an entire multi-stack
deployment (one region, one account) rather than varying stack to stack
the way a stack name does. Confirmed real need: `examples/02-complex-vpc-nat`
exports `${AWS::Region}-${AWS::StackName}-VPC`.

`AWS::NoValue` and `AWS::NotificationARNs` are deliberately excluded from
this placeholder map. Assuming a string value for a property-removal
pseudo parameter or a list-typed one, inside what must resolve to a single
export-name string, would be nonsensical — an export name that somehow
uses either stays unresolvable, surfaced via a `GraphWarning`-equivalent
(`ExportTableWarning`'s `unresolvableExportName`), never guessed.

### The assumption is scoped to `Export.Name` resolution only, never `Output.Value`

`buildExportSymbolTable()` resolves an Output's `Value` using the *plain*
`ResolutionContext` (no assumed pseudo parameters), even though the same
function has an assumed context available for the `Export.Name` next to
it. PO Question 4b specifically authorized assuming pseudo-parameter
values for **export/import name matching** — extending that same
assumption to arbitrary `Value` expressions would silently misrepresent
what the resource's actual (unknown) runtime value is, which is exactly
the guessing this project's "never silently guess" stance exists to
prevent. Keeping the assumption's blast radius exactly as narrow as what
was actually authorized is a deliberate, not incidental, choice.

### A regular `Parameters` entry (no `Default`) in an export name is a different, already-decided case

`examples/01-simple-lambda`'s `Export.Name: !Sub LambdaARN-${EnvName}` uses
`EnvName`, a plain parameter with no `Default` — not a pseudo parameter.
This is PO Question 2's existing "no `--parameters` file, never guess"
precedent applying completely unchanged: `usedAssumedPseudoParameters`
only ever concerns `AWS::*` names (detected via `containsPseudoParameterRef`
scanning the *plain*-context resolution, mutation-tested to confirm it's
load-bearing), so a parameter-dependent export name simply stays
unresolvable and is reported via the same `unresolvableExportName`
warning, distinguishable by its reason text (`depends on parameter
"EnvName" with no static Default`).

### Duplicate export names are removed from the lookup entirely, not merged

Per PO Question 4c: two or more entries (within one template, or across
templates — both cases tested, including order-independence: processing
`[A, B]` and `[B, A]` produce the same "conflict, not indexed" result)
resolving to the same `matchKey` are pulled *out* of `byName` and reported
as a `duplicateExportName` warning listing every occurrence, rather than
the table quietly keeping the first (or last) one. Mutation-tested:
building the table with the grouping/conflict step replaced by
unconditional last-wins insertion was confirmed to make 4 tests fail,
including the real fixture pair (`01-simple-lambda` +
`05-malformed-and-missing-ref`, both exporting the literal `LambdaRole`)
the ticket's own acceptance criteria names.

## Alternatives Considered

**Deriving `AWS::StackName` from folder name always.** Rejected — breaks
`06-nested-stack-quickstart`, whose three sibling templates share one
folder.

**Deriving it from filename always.** Rejected — breaks
`03-multi-stack-ecs-fargate`, whose three sibling templates are all
literally named `template.yaml`.

**Assuming a value for `AWS::Region`/etc. derived from some hash of the
file path (to at least be "per-file" as the original 4b text suggests).**
Considered and rejected — would produce a *different* assumed region per
template even when they're genuinely siblings in the same real deployment
(the overwhelmingly common real case, confirmed by every multi-file
example in `examples/`), actively working against successful matching
rather than enabling it. A fixed global value is more correct for what
these pseudo parameters actually represent.

**Applying the assumed context to `Output.Value` too, for symmetry.**
Rejected — see "scoped to `Export.Name` only" above.

## Consequences

- `ResolutionContext` gained one optional field
  (`assumedPseudoParameters?: Map<string, string>`) and `intrinsics.ts`'s
  `resolveRef` gained one additional branch, both additive and
  backward-compatible — every existing Sprint 1 test still passes
  unchanged, since the field is `undefined` unless a caller (only
  `graph/exports.ts`, so far) explicitly sets it.
- `assumedStackName()` is a general-purpose utility, not exports-specific —
  reusable by any future module that needs the same "pick a stable,
  distinct per-template label" concern (e.g. diagram rendering's stack
  grouping, Sprint 3+).
- The export symbol table only feeds Ticket 2.3's cross-stack edge
  building; it does not itself modify `GraphModel` — building
  `crossStackImport` edges by matching an `importValueRef.exportName`
  against this table's `byName` is Ticket 2.3's job.
