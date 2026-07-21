# ADR 0004: Import-side candidate stack-name matching (PO Question 4f)

**Status:** Accepted
**Date:** 2026-07-21
**Related:** Sprint 2, Ticket 2.3 (`src/graph/merge.ts`)

## Context

Ticket 2.3's own text said "Documentation Updates: None beyond 2.2" — written
before implementation began. Running the ticket's own named test fixture
(`examples/03-multi-stack-ecs-fargate`) surfaced a real gap ADR 0003 didn't
cover: `network-stack` exports via `!Ref AWS::StackName` (resolves through
PO Question 4b's assumed convention), but `service-stack`/
`private-subnet-public-service` import via `!Ref StackName` — a **regular
`Parameters` entry** (`Default: production`, description "the name of the
parent Fargate networking stack that you created"), not the pseudo
parameter. Resolved normally, the import side collapses to
`"production:ClusterName"`, which doesn't match `network-stack`'s assumed
`"network-stack:ClusterName"` — exact matching fails on every import in
the fixture the ticket names as its success case. This is a deliberate,
common upstream pattern (real deployments override the parameter), not a
template defect. Given how load-bearing this ticket's own fixture is, this
was surfaced to the user before writing the matching logic, the same as
every other genuine fork this project has hit.

## Decision

`graph/merge.ts`'s `resolveImportCall()` tries three strategies in order,
each strictly weaker than the last, each labeled on the resulting edge's
`matchedVia`:

1. **`'exact'`** — resolve the import's export-name expression with
   ordinary Sprint 1 behavior (parameter `Default`s used as-is). Matches
   whenever nothing pseudo-parameter- or assumption-dependent is involved.
2. **`'assumedPseudoParameter'`** (PO Question 4b) — only tried if the
   exact resolution actually depended on an `AWS::*` pseudo parameter;
   re-resolve with this template's own assumed pseudo-parameter values.
3. **`'assumedCandidateStackName'`** (PO Question 4f, this ADR) — retry
   once per *other* template being merged, forcing every `Parameters`
   reference in the expression (via `buildCandidateContext()`, a throwaway
   `ResolutionContext` whose `parameters` map is entirely overridden to one
   synthetic literal) to that other template's own `assumedStackName()`.
   Accepted only if **exactly one** candidate template's substitution
   produces a match against the export table — zero or two-or-more
   distinct matches stays genuinely ambiguous, flagged via a
   `GraphWarning` (`kind: 'unresolvedImport'`), never guessed.

Candidates are deduplicated by the *export entry* they resolve to
(`${entry.file}#${entry.outputName}`), not by the candidate string itself —
two different candidate stack names could coincidentally produce the same
literal match key in principle, and that should count as one match, not
two, when deciding ambiguity.

## Alternatives Considered

**Treat any non-matching parameter-based import as simply unresolved (no
candidate search).** Rejected — this is exactly what was considered as
Ticket 2.3's "simpler" option when this was raised. It would mean the
ticket's own named fixture pair demonstrates zero successful cross-stack
edges, defeating the AC it's meant to exercise. The user chose the
candidate-search approach specifically so this real fixture works.

**Treat *any* Ref inside an import expression as a wildcard (accept any
value found in the table matching the expression's literal-segment
"shape"), without requiring the substituted value to be one of the actual
templates' own assumed stack names.** Considered and rejected as too
unbounded — it would accept a match against a completely arbitrary string
with the right shape, rather than only values already computed elsewhere
in this same merge run. Restricting candidates to real siblings'
`assumedStackName()` values keeps the assumption bounded and inspectable.

**Detect *which* parameter is "the stack name" by name or description
(e.g. a parameter literally called `StackName`, or whose description
mentions "stack").** Rejected — parsing English prose or relying on a
naming convention that isn't guaranteed is a worse kind of guessing than
substituting a known candidate value into whichever parameter(s) are
actually present; forcing *every* parameter inside the small import
expression to the same candidate, uniformly, needs no such fragile
detection and produces the identical result for this project's real
fixtures.

## Consequences

- An import expression with more than one *distinct* unresolved parameter
  (e.g. combining a real stack-name parameter with an unrelated one that
  also lacks a matching default) would have every such parameter forced to
  the *same* candidate value. Not a problem for any current real fixture
  (each observed case uses exactly one parameter in this position), but a
  template combining two genuinely different parameters this way could in
  principle produce a coincidental false match. Always labeled
  `matchedVia: 'assumedCandidateStackName'` — the weakest, most-assumed
  case — so this risk is visible, not silent.
- `matchedVia` on every `crossStackImport` edge gives downstream consumers
  (rendering, blast radius) a way to visually or programmatically
  distinguish a confident match from an assumed one, without needing to
  re-derive that confidence themselves.
- This mechanism only activates when steps 1 and 2 both fail to find a
  match — for templates using `AWS::StackName` symmetrically on both sides
  (the common case, e.g. `02-complex-vpc-nat`-style single-template
  exports), it never triggers at all.
