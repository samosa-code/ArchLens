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

✅ **Sprint 1 (parser) is complete.** ✅ **Sprint 2 (graph model) is
complete through Ticket 2.4.** 🚧 **Sprint 3 (rendering) is in progress
— Tickets 3.1 (HTML bundle scaffolding) and 3.2 (layout & SVG rendering)
done.** Scoped from a PRD and sprint/ticket plan (see `internal-docs/`,
kept local/untracked for now).
Implementation follows the build order: parser → graph model → render →
search → blast radius → export → security/cost flags → diff → CI
integration → polish.

Sprint 1 delivered: YAML/JSON loading with source positions and
skip-and-warn multi-file handling, full intrinsic-function resolution
(`Ref`, `Fn::GetAtt`, `Fn::Join`, `Fn::Select`, `Fn::Sub`, `Fn::FindInMap`,
`Fn::ImportValue` (stub), `Fn::If`) with arbitrary nesting depth, and
`Conditions`-block evaluation. See
[`docs/parser-architecture.md`](docs/parser-architecture.md) for that
pipeline end to end.

Sprint 2 delivered: a resource graph (`GraphNode`/`GraphEdge`) built from
one template, an export/import symbol table across N templates (with an
explicitly-labeled "assumed" resolution strategy for the deploy-time-only
values, like `AWS::StackName`, that real export names are built from — see
"How multi-stack merging works" below), cross-stack `Fn::ImportValue`
resolution into `crossStackImport` edges, and a CLI demo
(`npm run demo -- "<glob>"`) that runs the whole pipeline and prints a
summary. See [`docs/graph-architecture.md`](docs/graph-architecture.md)
for that pipeline end to end.

Sprint 3 so far: the bundle-and-inline pipeline that turns a graph into
one self-contained `index.html` (Ticket 3.1) — `esbuild` bundles the
browser-side renderer with its data baked in as a literal, zero network
requests once opened, verified with a real headless browser — plus real
graph layout via `@dagrejs/dagre`, drag-to-pan/wheel-to-zoom, and
responsive rendering up to 1,000 nodes (Ticket 3.2). Run
`npm run render:demo` to write a real, openable 24-node example. Still a
synthetic sample graph, not the real pipeline — that wiring is Ticket 3.4.
See [`docs/render-architecture.md`](docs/render-architecture.md).

[`docs/developer-guide.md`](docs/developer-guide.md) is the project-wide
doc index across all sprints, and [`LIMITATIONS.md`](LIMITATIONS.md)
tracks what's deliberately not supported yet.

## How multi-stack merging works

Real CloudFormation deployments are rarely one template — a common pattern
is a "network" stack that exports its VPC/subnet/cluster IDs via `Outputs`
+ `Export`, and one or more "service" stacks that consume them via
`Fn::ImportValue`. ArchLens merges any number of template files you point
it at into one graph, connecting these across files wherever it can:

```
npm run demo -- "path/to/stacks/*/template.yaml"
```

1. **Each template becomes its own subgraph first** (`buildGraph()`) —
   nodes for every resource, edges for same-template `Ref`/`Fn::GetAtt`
   references and `DependsOn`. A resource's identity always includes which
   file it came from, so two unrelated templates that happen to reuse the
   same logical ID (e.g. both call something `Role`) never get silently
   merged into one node.
2. **Every `Outputs`/`Export` across every template is indexed** into one
   lookup table, keyed by the export's name.
3. **Every `Fn::ImportValue` is matched against that table.** A matched
   import becomes a real edge connecting a resource in the *consuming*
   template to a resource in the *exporting* one.

The wrinkle: an export's name is very often built from `AWS::StackName` —
a value CloudFormation only knows at actual deploy time, which a purely
static tool reading template files on disk cannot. Rather than give up and
call every cross-stack reference unresolvable, ArchLens assumes a stable,
consistent stand-in value per template (derived from its file/folder name)
so that two sibling templates' export and import expressions still line up
— but this is **always an assumption, clearly labeled as such**
(`matchedVia` on the resulting edge), never presented as if it were a real
deployed value. An import that still can't be matched to any export across
the files you provided is flagged, both as a CLI warning and (once
rendering exists) a visible marker on the graph — the run always completes
with whatever *did* resolve rather than failing outright.

Full detail, including the specific real-world CloudFormation patterns
that shaped this (and the one case where two service templates in the same
example fixture deliberately *don't* fully resolve, because they genuinely
want different network stacks): [`docs/graph-architecture.md`](docs/graph-architecture.md).

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
