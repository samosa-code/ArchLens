import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { buildRenderGraph, parseArgs, resolveInputFiles, summarize, type CliOptions } from '../cli.js';
import { loadTemplates } from '../parser/loader.js';
import { mergeGraphs } from '../graph/merge.js';

const REAL_WORLD_EXAMPLES = new URL('../../examples/', import.meta.url);

function examplePath(name: string): string {
  return fileURLToPath(new URL(name, REAL_WORLD_EXAMPLES));
}

describe('resolveInputFiles', () => {
  test('expands a glob pattern to every matching file, de-duplicated and sorted', async () => {
    const pattern = examplePath('03-multi-stack-ecs-fargate/*/template.yaml');
    const files = await resolveInputFiles([pattern]);

    expect(files).toHaveLength(3);
    expect(files).toEqual([...files].sort());
    expect(files.every((f) => f.endsWith('template.yaml'))).toBe(true);
  });

  test('accepts a literal file path exactly like a single-file glob', async () => {
    const file = examplePath('01-simple-lambda/template.yaml');
    const files = await resolveInputFiles([file]);
    expect(files).toEqual([file]);
  });

  test('multiple patterns matching overlapping files are de-duplicated into one list', async () => {
    const file = examplePath('01-simple-lambda/template.yaml');
    const files = await resolveInputFiles([file, file]);
    expect(files).toEqual([file]);
  });

  test('a pattern matching nothing resolves to an empty list, not an error', async () => {
    const files = await resolveInputFiles([examplePath('no-such-directory/*.yaml')]);
    expect(files).toEqual([]);
  });
});

describe('summarize', () => {
  test('reports node count, edge count by kind, and every resolved/unresolved cross-stack reference', async () => {
    const networkFile = examplePath('03-multi-stack-ecs-fargate/network-stack/template.yaml');
    const serviceFile = examplePath('03-multi-stack-ecs-fargate/service-stack/template.yaml');
    const { templates, warnings } = loadTemplates([networkFile, serviceFile]);
    const graph = mergeGraphs(templates);

    const output = summarize(graph, warnings);

    expect(output).toContain('Templates loaded: 2');
    expect(output).toContain(`Nodes: ${graph.nodes.length}`);
    expect(output).toContain(`Edges: ${graph.edges.length}`);
    expect(output).toContain('Resolved cross-stack references: 7');
    expect(output).toContain('Unresolved cross-stack references: 0');
  });

  test('surfaces a genuinely unresolved import in its own section, distinct from resolved ones', async () => {
    const file = examplePath('04-unresolved-import/template.yaml');
    const { templates, warnings } = loadTemplates([file]);
    const graph = mergeGraphs(templates);

    const output = summarize(graph, warnings);

    expect(output).toContain('Resolved cross-stack references: 0');
    expect(output).toMatch(/Unresolved cross-stack references: [1-9]/);
    expect(output).toContain(file);
  });

  test('surfaces file-load warnings in their own section when a file fails to load', async () => {
    const validFile = examplePath('01-simple-lambda/template.yaml');
    const invalidFile = examplePath('05-malformed-and-missing-ref/invalid-yaml.yaml');
    const { templates, warnings } = loadTemplates([validFile, invalidFile]);
    const graph = mergeGraphs(templates);

    const output = summarize(graph, warnings);

    expect(output).toContain('Files that failed to load: 1');
    expect(output).toContain(invalidFile);
  });
});

/**
 * Ticket 3.4 — the real CLI: `archlens <glob...> --out <dir>`, plus
 * `--raw`/`--explain`/`--layer=<list>`/`--hide-monitoring`.
 */
describe('parseArgs', () => {
  test('a single pattern with no flags: outDir defaults, every boolean flag defaults false', () => {
    const result = parseArgs(['./templates/*.yaml']);
    expect(result).toMatchObject({ patterns: ['./templates/*.yaml'], raw: false, explain: false, hideMonitoring: false });
    expect((result as CliOptions).layers).toBeUndefined();
    expect((result as CliOptions).outDir).toBeTruthy(); // a real default path, not empty/undefined
  });

  test('multiple positional patterns are all collected, not just the last one', () => {
    const result = parseArgs(['a.yaml', 'b.yaml', 'c/**/*.yaml']) as CliOptions;
    expect(result.patterns).toEqual(['a.yaml', 'b.yaml', 'c/**/*.yaml']);
  });

  test('--out <dir> is captured and consumes its value (the value itself is never treated as a pattern)', () => {
    const result = parseArgs(['a.yaml', '--out', './my-diagram']) as CliOptions;
    expect(result.outDir).toBe('./my-diagram');
    expect(result.patterns).toEqual(['a.yaml']);
  });

  test('--out with no following value is a parse error, not a silent fallback', () => {
    const result = parseArgs(['a.yaml', '--out']);
    expect('error' in result).toBe(true);
  });

  test('--raw, --explain, --hide-monitoring are recognized independently', () => {
    const result = parseArgs(['a.yaml', '--raw', '--explain', '--hide-monitoring']) as CliOptions;
    expect(result.raw).toBe(true);
    expect(result.explain).toBe(true);
    expect(result.hideMonitoring).toBe(true);
  });

  test('--layer=<list> splits on commas and trims whitespace', () => {
    const result = parseArgs(['a.yaml', '--layer=compute, data ,api']) as CliOptions;
    expect(result.layers).toEqual(['compute', 'data', 'api']);
  });

  test('no patterns at all is a parse error with a usage message', () => {
    const result = parseArgs(['--raw']);
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toContain('archlens');
  });

  test('an unrecognized flag is a parse error, not silently ignored', () => {
    const result = parseArgs(['a.yaml', '--nonsense']);
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toContain('--nonsense');
  });
});

describe('buildRenderGraph', () => {
  const EXAMPLES_DIR = fileURLToPath(new URL('../../examples/', import.meta.url));
  const baseOptions: CliOptions = { patterns: [], outDir: '', raw: false, explain: false, hideMonitoring: false };

  test('default (no --raw): runs the Architecture Generator — the absorbed IAM Role does not become its own box', () => {
    const { templates } = loadTemplates([EXAMPLES_DIR + '01-simple-lambda/template.yaml']);
    const graph = mergeGraphs(templates);
    const { renderGraph } = buildRenderGraph(graph, baseOptions);
    expect(renderGraph.nodes).toHaveLength(1); // the Function; Role absorbed
  });

  test('--raw: bypasses the Architecture Generator entirely — every resource is its own box, 1:1 with GraphModel', () => {
    const { templates } = loadTemplates([EXAMPLES_DIR + '01-simple-lambda/template.yaml']);
    const graph = mergeGraphs(templates);
    const { renderGraph } = buildRenderGraph(graph, { ...baseOptions, raw: true });
    expect(renderGraph.nodes).toHaveLength(2); // Function AND Role, un-absorbed
  });

  test('--explain produces a report string alongside the render graph (not instead of it)', () => {
    const { templates } = loadTemplates([EXAMPLES_DIR + '01-simple-lambda/template.yaml']);
    const graph = mergeGraphs(templates);
    const { renderGraph, explainOutput } = buildRenderGraph(graph, { ...baseOptions, explain: true });
    expect(renderGraph.nodes).toHaveLength(1);
    expect(explainOutput).toBeDefined();
    expect(explainOutput).toContain('decisions');
  });

  test('--explain is absent (undefined) when not requested — the CLI must be able to tell "not asked for" apart from "empty report"', () => {
    const { templates } = loadTemplates([EXAMPLES_DIR + '01-simple-lambda/template.yaml']);
    const graph = mergeGraphs(templates);
    const { explainOutput } = buildRenderGraph(graph, baseOptions);
    expect(explainOutput).toBeUndefined();
  });

  test('--layer allowlist is applied to the generated graph, not the raw one', () => {
    const { templates } = loadTemplates([EXAMPLES_DIR + '09-sam-apigw-lambda-dynamodb/template.yaml']);
    const graph = mergeGraphs(templates);
    const { renderGraph } = buildRenderGraph(graph, { ...baseOptions, layers: ['data'] });
    expect(renderGraph.nodes.every((n) => n.layer === 'data')).toBe(true);
    expect(renderGraph.nodes.length).toBeGreaterThan(0);
  });
});
