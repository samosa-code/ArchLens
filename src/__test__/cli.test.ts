import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { resolveInputFiles, summarize } from '../cli.js';
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
