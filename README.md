```
        _             _     _
       / \   _ __ ___| |__ | |    ___ _ __  ___
      / _ \ | '__/ __| '_ \| |   / _ \ '_ \/ __|
     / ___ \| | | (__| | | | |__|  __/ | | \__ \
    /_/   \_\_|  \___|_| |_|_____\___|_| |_|___/

```

> **Ask your infrastructure a question. See the answer, not a wall of YAML.**

## What is this?

**ArchLens** is a zero-config CLI (`npx archlens ...`) that parses AWS
CloudFormation templates into a queryable model of your infrastructure — not
just a picture of it. It renders a diagram, but the diagram is the
*interface*, not the product. The product is answering the questions
engineers actually have day to day:

- "Why is this Lambda public?"
- "What can reach this S3 bucket?"
- "What breaks if I delete this resource?"
- "What did this PR actually change?"

Existing CFN diagram tools stop at "here's a picture." ArchLens is built
around three workflows a static picture can't give you:

- **Search** — a `Ctrl+K` query bar over the resource graph (`Lambda connected
  to DynamoDB`, `resources exposed to internet`).
- **Blast radius** — click a resource to see what it can reach (downstream)
  and what depends on it (upstream).
- **Diff** — compare two versions of a template set as a visual, color-coded
  graph diff instead of a raw YAML text diff, with GitHub PR integration as
  the primary way this shows up in your workflow.

Ships as a single self-contained HTML file — no server, no build step to
view it, no AWS credentials required. Static analysis only.

## Status

✅ **Sprint 1 (parser) is complete.** Scoped from a PRD and sprint/ticket
plan (see `internal-docs/`, kept local/untracked for now). Implementation
follows the build order: parser → graph model → render → search → blast
radius → export → security/cost flags → diff → CI integration → polish —
Sprint 2 (graph model) is next.

Delivered: YAML/JSON loading with source positions and skip-and-warn
multi-file handling, full intrinsic-function resolution (`Ref`,
`Fn::GetAtt`, `Fn::Join`, `Fn::Select`, `Fn::Sub`, `Fn::FindInMap`,
`Fn::ImportValue` (stub), `Fn::If`) with arbitrary nesting depth, and
`Conditions`-block evaluation. See
[`docs/parser-architecture.md`](docs/parser-architecture.md) for the
pipeline end to end, [`docs/developer-guide.md`](docs/developer-guide.md)
for the project-wide doc index, and [`LIMITATIONS.md`](LIMITATIONS.md) for
what's deliberately not supported yet.

## Non-goals (for now)

- Application-layer traffic detection (needs runtime data — out of scope for
  static template analysis).
- Terraform / other IaC formats.
- Live AWS API integration or drift detection.
- Editing templates from the UI — read-only, by design.

## Troubleshooting

### What happens with invalid input

Loading multiple templates never aborts the whole run over one bad file —
each file is loaded independently, and a file that can't be parsed is
**skipped with a warning**, not silently dropped and not treated as fatal.
Every other file still loads and is included in the result.

This applies to genuine parse failures:

- Invalid YAML syntax (e.g. a tab character used for indentation, which
  YAML's spec disallows).
- Invalid JSON (CloudFormation's JSON format is strict — no trailing
  commas, no comments — unlike some JSON-with-comments tools you may have
  used).

It does **not** apply to a template that parses fine but references
something that doesn't exist — e.g. a `Fn::GetAtt` pointing at an
undeclared resource. That's not a load failure: the file loads normally,
and the specific broken reference resolves to an explicit "unresolved"
result (with a reason) wherever it's used, rather than crashing or being
silently guessed. See [`LIMITATIONS.md`](LIMITATIONS.md) for the full list
of what's flagged this way versus what's out of scope entirely.

## License

MIT — see [LICENSE](./LICENSE).
