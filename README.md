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

📋 **Planning stage — no code yet.** The project is currently scoped as a
PRD and sprint/ticket plan (see `internal-docs/`, kept local/untracked for
now). Implementation follows the build order: parser → graph model →
render → search → blast radius → export → security/cost flags → diff → CI
integration → polish.

## Non-goals (for now)

- Application-layer traffic detection (needs runtime data — out of scope for
  static template analysis).
- Terraform / other IaC formats.
- Live AWS API integration or drift detection.
- Editing templates from the UI — read-only, by design.

## License

MIT — see [LICENSE](./LICENSE).
