# Developer Guide

Index of ArchLens's internals, one entry per module or module group, added
as each is built. Each entry is a short summary — the real depth lives in
its own linked doc, so this file stays a map, not something that itself
grows unwieldy across sprints.

## Parser (Sprint 1)

Loads CloudFormation template files from disk, resolves their intrinsic
functions (`Ref`, `Fn::GetAtt`, `Fn::Join`, `Fn::Select`, `Fn::Sub`,
`Fn::FindInMap`, `Fn::ImportValue` (stub), `Fn::If`) to arbitrary nesting
depth, and evaluates the `Conditions` block to determine per-resource
inclusion — all statically, from the template files alone, per the
project's static-analysis-only scope.

**Modules:** `src/parser/loader.ts`, `src/parser/intrinsics.ts`,
`src/parser/conditions.ts`, `src/parser/getAttShorthand.ts`

**Full detail:** [`docs/parser-architecture.md`](parser-architecture.md) —
pipeline overview, per-function behavior, and the design principles that
recur across every stage (never silently guess; keep partial information
rather than giving up; validate against real templates, not only
synthetic fixtures).

**Related:** [ADR 0001](adr/0001-yaml-json-parser-choice.md) (parser
library choice) · [`LIMITATIONS.md`](../LIMITATIONS.md) (current gaps)

---

*(Sprint 2+ modules — graph model, search, blast radius, diff, rendering —
get their own entries here as they're built.)*
