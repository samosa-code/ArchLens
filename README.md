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
complete through Ticket 2.4.** ✅ **Sprint 3 (rendering) is complete**
(Tickets 3.1–3.4, the last two done after Sprint 3.5 landed — see below).
✅ **Sprint 3.5 (Architecture Generator) is complete** (Tickets A.1–A.12).
Scoped from a PRD and sprint/ticket plan (see `internal-docs/`, kept
local/untracked for now).
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
"How multi-stack merging works" below), and cross-stack `Fn::ImportValue`
resolution into `crossStackImport` edges. See
[`docs/graph-architecture.md`](docs/graph-architecture.md) for that
pipeline end to end.

Sprint 3.5 (inserted between Tickets 3.3 and 3.4 once it became clear the
naive "draw every resource as a box" approach silently deletes real
architecture — see [ADR 0008](docs/adr/0008-connector-resources-as-edges.md))
delivered the Architecture Generator: `GraphModel → ArchitectureGraph`,
the six-pass reduction that turns a raw, hundreds-of-resources graph into
a handful of real logical components. See
[`docs/architecture-generation.md`](docs/architecture-generation.md).

Sprint 3 delivered the full render pipeline on top of that: the
bundle-and-inline pipeline that turns a graph into one self-contained
`index.html` (Ticket 3.1) — `esbuild` bundles the browser-side renderer
with its data baked in as a literal, zero network requests once opened,
verified with a real headless browser — real graph layout via
`@dagrejs/dagre`, drag-to-pan/wheel-to-zoom, and responsive rendering up
to 1,000 nodes (Ticket 3.2), a click-for-details side panel (Ticket 3.3),
and the real CLI, `npx archlens <glob> --out <dir>` (Ticket 3.4 — see
"CLI usage" below). Run `npm run render:demo` for a real, openable
example without installing anything: the same real 5-template merge as
`npm run arch:demo`, run through the full `GraphModel → ArchitectureGraph
→ RenderGraph` pipeline. See
[`docs/render-architecture.md`](docs/render-architecture.md).

[`docs/developer-guide.md`](docs/developer-guide.md) is the project-wide
doc index across all sprints, and [`LIMITATIONS.md`](LIMITATIONS.md)
tracks what's deliberately not supported yet.

## How to use the diagram (Sprint 3, Ticket 3.3)

Open the generated `index.html` in a browser (no server, no network —
everything is baked into the one file):

- **Pan** — click and drag anywhere on empty canvas.
- **Zoom** — scroll/pinch; zoom is anchored to your cursor position and
  clamped so you can't zoom out past being useless or in past being
  meaningless.
- **Click any box** to open its detail panel on the right: what it is
  (type, layer, and where it's declared in your template), a security-
  finding callout if it has one, everything CloudFormation-level that got
  folded into it (grouped as Permissions / Networking / Observability /
  Lifecycle / Plumbing — only the groups that actually have something in
  them appear), and a Connections list showing what it talks to and how
  (e.g. "invokes → RestApi", "reads/writes ← PutItemsFunction (lambda)").
- **Close the panel** with the × button, or click a different box to
  replace its contents.

Two things the panel deliberately does *not* do yet, so you're not
surprised: it doesn't draw VPC/Subnet/account boundaries as nested boxes
on the canvas (the containment relationship exists in the data — a
future ticket adds the visual nesting); and `file:line` in the panel is
plain text, not a clickable "jump to source" link — a self-contained
exported HTML file has nothing to jump *to*.

## CLI usage (Sprint 3, Ticket 3.4)

```
npx archlens <glob-or-file...> [--out <dir>] [--raw] [--explain] [--layer=<list>] [--hide-monitoring]
```

Point it at one or more CloudFormation template files (or glob patterns —
`./infra/**/*.yaml` works, matching any number of files across any number
of directories). Every matched file is loaded, merged into one graph
(cross-stack `Fn::ImportValue`s resolved where possible), reduced by the
Architecture Generator, and written out as one self-contained,
openable-offline `index.html` — no server, no build step, no network
request once it's open.

```
$ npx archlens ./infra/**/*.yaml --out ./diagram
Wrote ./diagram/index.html
```

**Flags:**

| Flag | Effect |
|---|---|
| `--out <dir>` | Where to write `index.html`. Defaults to `./archlens-output` (relative to wherever you ran the command) when omitted. |
| `--raw` | Skip the Architecture Generator entirely — every CloudFormation resource gets its own box, 1:1 with the raw graph. For when you don't trust the abstraction and want to see everything, or you're debugging the generator itself. |
| `--explain` | Alongside writing the HTML, prints every `AbstractionDecision` to stdout (what happened to each resource, and why) plus the `unknownTypes` worklist ranked by frequency — the signal for which rule to add next. Has no effect combined with `--raw` (the 1:1 view has no abstraction decisions to report). |
| `--layer=<list>` | Comma-separated allowlist (e.g. `--layer=compute,data`) — only components in these layers survive; everything else (and any edge touching a dropped node) is left out of the diagram. Has no effect combined with `--raw` (no layer concept there). |
| `--hide-monitoring` | Opt-out: hides the `monitoring` layer (CloudWatch, X-Ray). Monitoring is **visible by default** — this is the only way to turn it off, there's no equivalent opt-in flag. Has no effect combined with `--raw`. |

A pattern matching no files, or an unrecognized flag, fails clearly with
a message on stderr and a non-zero exit code rather than writing an empty
or partial diagram.

See "How to use the diagram" above for what to do once `index.html` is
open, and [`docs/render-architecture.md`](docs/render-architecture.md)/
[`docs/architecture-generation.md`](docs/architecture-generation.md) for
how the pipeline behind it works.

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
