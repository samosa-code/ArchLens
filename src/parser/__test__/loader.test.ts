import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { loadTemplate } from '../loader.js';
import type { AstNode } from '../../common/types.js';

const FIXTURES = new URL('./__fixtures__/', import.meta.url);
const REAL_WORLD_EXAMPLES = new URL('../../../examples/', import.meta.url);

function fixturePath(name: string): string {
  return fileURLToPath(new URL(name, FIXTURES));
}

function examplePath(name: string): string {
  return fileURLToPath(new URL(name, REAL_WORLD_EXAMPLES));
}

/** Strips {@link SourcePosition} metadata, leaving only the plain JS value an AstNode represents. */
function toPlainValue(node: AstNode): unknown {
  if (node.kind === 'scalar') return node.value;
  if (node.kind === 'array') return node.items.map(toPlainValue);
  return Object.fromEntries(node.entries.map((entry) => [entry.key, toPlainValue(entry.value)]));
}

describe('loadTemplate', () => {
  test('loads a simple YAML file into an object AST node', () => {
    const path = fixturePath('simple.yaml');

    const ast = loadTemplate(path);

    expect(ast.kind).toBe('object');
  });

  test('captures top-level scalar entries with correct keys and values', () => {
    const path = fixturePath('simple.yaml');

    const ast = loadTemplate(path);
    if (ast.kind !== 'object') throw new Error('expected object node');

    expect(ast.entries).toHaveLength(2);
    expect(ast.entries[0]?.key).toBe('Foo');
    expect(ast.entries[0]?.value).toMatchObject({ kind: 'scalar', value: 'bar' });
    expect(ast.entries[1]?.key).toBe('Count');
    expect(ast.entries[1]?.value).toMatchObject({ kind: 'scalar', value: 3 });
  });

  test('records file/line/column position for every node', () => {
    const path = fixturePath('simple.yaml');

    const ast = loadTemplate(path);
    if (ast.kind !== 'object') throw new Error('expected object node');

    // simple.yaml:
    // 1: Foo: bar
    // 2: Count: 3
    expect(ast.entries[0]?.keyPos).toEqual({ file: path, line: 1, column: 1 });
    expect(ast.entries[0]?.value.pos).toEqual({ file: path, line: 1, column: 6 });
    expect(ast.entries[1]?.keyPos).toEqual({ file: path, line: 2, column: 1 });
    expect(ast.entries[1]?.value.pos).toEqual({ file: path, line: 2, column: 8 });
  });

  test('loads a simple JSON file into an object AST node with the same entries as its YAML counterpart', () => {
    const path = fixturePath('simple.json');

    const ast = loadTemplate(path);
    if (ast.kind !== 'object') throw new Error('expected object node');

    expect(ast.entries).toHaveLength(2);
    expect(ast.entries[0]?.key).toBe('Foo');
    expect(ast.entries[0]?.value).toMatchObject({ kind: 'scalar', value: 'bar' });
    expect(ast.entries[1]?.key).toBe('Count');
    expect(ast.entries[1]?.value).toMatchObject({ kind: 'scalar', value: 3 });
  });

  test('rejects YAML that uses a literal tab for indentation', () => {
    const path = fixturePath('tabs-indentation.yaml');

    expect(() => loadTemplate(path)).toThrow();
  });

  test('rejects JSON with a trailing comma', () => {
    const path = fixturePath('trailing-comma.json');

    expect(() => loadTemplate(path)).toThrow();
  });

  test('normalizes YAML short-form intrinsic tags to CFN long-form objects', () => {
    const path = fixturePath('short-form-tags.yaml');

    const ast = loadTemplate(path);
    if (ast.kind !== 'object') throw new Error('expected object node');
    const byKey = Object.fromEntries(ast.entries.map((entry) => [entry.key, toPlainValue(entry.value)]));

    expect(byKey.Env).toEqual({ Ref: 'EnvName' });
    expect(byKey.Alias).toEqual({ 'Fn::GetAtt': ['LambdaRole', 'Arn'] });
    // Only the first dot splits resource from attribute; the rest is a nested attribute path.
    expect(byKey.NestedAttr).toEqual({ 'Fn::GetAtt': ['Nested', 'Outputs.Value'] });
    expect(byKey.Msg).toEqual({ 'Fn::Sub': 'hi ${EnvName}' });
    expect(byKey.Choice).toEqual({ 'Fn::If': ['IsProd', 'a', 'b'] });
  });

  test('produces an equivalent AST for real-world YAML and JSON templates covering the same resources', () => {
    const yamlAst = loadTemplate(examplePath('01-simple-lambda/template.yaml'));
    const jsonAst = loadTemplate(examplePath('01-simple-lambda/template.json'));

    expect(toPlainValue(jsonAst)).toEqual(toPlainValue(yamlAst));
  });

  test('every node in a loaded real-world template carries a valid source position', () => {
    const path = examplePath('01-simple-lambda/template.yaml');
    const ast = loadTemplate(path);

    function assertValidPositions(node: AstNode): void {
      expect(node.pos.file).toBe(path);
      expect(node.pos.line).toBeGreaterThan(0);
      expect(node.pos.column).toBeGreaterThan(0);

      if (node.kind === 'object') {
        for (const entry of node.entries) {
          expect(entry.keyPos.file).toBe(path);
          expect(entry.keyPos.line).toBeGreaterThan(0);
          expect(entry.keyPos.column).toBeGreaterThan(0);
          assertValidPositions(entry.value);
        }
      } else if (node.kind === 'array') {
        node.items.forEach(assertValidPositions);
      }
    }

    assertValidPositions(ast);
  });

  test('loads a large real-world template with heavy FindInMap/Select/GetAZs/Join usage without error', () => {
    const path = examplePath('02-complex-vpc-nat/template.yaml');

    const ast = loadTemplate(path);
    if (ast.kind !== 'object') throw new Error('expected object node');

    const resources = ast.entries.find((entry) => entry.key === 'Resources');
    if (resources?.value.kind !== 'object') throw new Error('expected Resources to be an object');
    expect(resources.value.entries.length).toBeGreaterThan(15);

    const vpc = resources.value.entries.find((entry) => entry.key === 'VPC');
    if (vpc?.value.kind !== 'object') throw new Error('expected VPC resource to be an object');
    const properties = vpc.value.entries.find((entry) => entry.key === 'Properties');
    if (properties?.value.kind !== 'object') throw new Error('expected Properties to be an object');
    const cidrBlock = properties.value.entries.find((entry) => entry.key === 'CidrBlock');
    expect(toPlainValue(cidrBlock!.value)).toEqual({ 'Fn::FindInMap': ['SubnetConfig', 'VPC', 'CIDR'] });
  });
});
