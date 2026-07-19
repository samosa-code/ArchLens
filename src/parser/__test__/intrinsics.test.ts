import { fileURLToPath } from 'node:url';
import { describe, expect, test, beforeAll } from 'vitest';
import { loadTemplate } from '../loader.js';
import { buildResolutionContext, resolveValue } from '../intrinsics.js';
import type { AstNode } from '../../common/types.js';
import type { ResolutionContext } from '../../common/interfaces.js';

const FIXTURES = new URL('./__fixtures__/', import.meta.url);
const REAL_WORLD_EXAMPLES = new URL('../../../examples/', import.meta.url);

function fixturePath(name: string): string {
  return fileURLToPath(new URL(name, FIXTURES));
}

function examplePath(name: string): string {
  return fileURLToPath(new URL(name, REAL_WORLD_EXAMPLES));
}

function getEntry(node: AstNode, key: string): AstNode {
  if (node.kind !== 'object') throw new Error(`expected object node looking for key "${key}"`);
  const entry = node.entries.find((e) => e.key === key);
  if (!entry) throw new Error(`missing key "${key}"`);
  return entry.value;
}

function getPath(node: AstNode, ...keys: string[]): AstNode {
  return keys.reduce(getEntry, node);
}

describe('resolveValue', () => {
  let template: AstNode;
  let context: ResolutionContext;

  beforeAll(() => {
    template = loadTemplate(fixturePath('intrinsics-basic.yaml'));
    context = buildResolutionContext(template);
  });

  function consumerProp(key: string): AstNode {
    return getPath(template, 'Resources', 'Consumer', 'Properties', key);
  }

  describe('Ref', () => {
    test('to a declared resource resolves to a resourceRef', () => {
      const result = resolveValue(consumerProp('RefToResource'), context);
      expect(result).toEqual({ kind: 'resourceRef', logicalId: 'MyBucket' });
    });

    test('to a parameter with a Default resolves to that literal value', () => {
      const result = resolveValue(consumerProp('RefToParamWithDefault'), context);
      expect(result).toEqual({ kind: 'scalar', value: 't2.micro' });
    });

    test('to a parameter with no Default resolves to a parameterRef', () => {
      const result = resolveValue(consumerProp('RefToParamNoDefault'), context);
      expect(result).toEqual({ kind: 'parameterRef', name: 'EnvName' });
    });

    test('to an AWS pseudo parameter resolves to a pseudoParameterRef', () => {
      const result = resolveValue(consumerProp('RefToPseudo'), context);
      expect(result).toEqual({ kind: 'pseudoParameterRef', name: 'AWS::Region' });
    });

    test('to an undefined name resolves to unresolved with a clear reason', () => {
      const result = resolveValue(consumerProp('RefToUndefined'), context);
      expect(result).toEqual({ kind: 'unresolved', reason: 'Ref to undefined name "DoesNotExist"' });
    });
  });

  describe('Fn::GetAtt', () => {
    test('array form resolves to an attributeRef', () => {
      const result = resolveValue(consumerProp('GetAttArrayForm'), context);
      expect(result).toEqual({ kind: 'attributeRef', logicalId: 'MyBucket', attribute: 'Arn' });
    });

    test('dotted-string form resolves to the same attributeRef as array form', () => {
      const result = resolveValue(consumerProp('GetAttDottedForm'), context);
      expect(result).toEqual({ kind: 'attributeRef', logicalId: 'MyBucket', attribute: 'Arn' });
    });

    test('only the first dot splits resource from a nested attribute name', () => {
      const result = resolveValue(consumerProp('GetAttNestedAttr'), context);
      expect(result).toEqual({ kind: 'attributeRef', logicalId: 'MyBucket', attribute: 'Outputs.Value' });
    });

    test('targeting an undeclared resource resolves to unresolved', () => {
      const result = resolveValue(consumerProp('GetAttUndefinedResource'), context);
      expect(result).toEqual({
        kind: 'unresolved',
        reason: 'Fn::GetAtt to undeclared resource "NoSuchResource"',
      });
    });
  });

  describe('Fn::Join', () => {
    test('with a fully static delimiter and parts resolves to the computed string', () => {
      const result = resolveValue(consumerProp('JoinFullyStatic'), context);
      expect(result).toEqual({ kind: 'scalar', value: 'a-b-c' });
    });

    test('with a non-static part falls back to the resolved parts, preserving the reference', () => {
      const result = resolveValue(consumerProp('JoinWithReference'), context);
      expect(result).toEqual({
        kind: 'list',
        items: [{ kind: 'resourceRef', logicalId: 'MyBucket' }, { kind: 'scalar', value: 'suffix' }],
      });
    });

    test('with a non-literal delimiter resolves to unresolved', () => {
      const result = resolveValue(consumerProp('JoinNonLiteralDelimiter'), context);
      expect(result).toEqual({
        kind: 'unresolved',
        reason: 'Fn::Join delimiter is not statically determinable',
      });
    });
  });

  describe('Fn::Select', () => {
    test('with a static index into a fully literal list resolves to the selected literal', () => {
      const result = resolveValue(consumerProp('SelectStaticIntoLiteralList'), context);
      expect(result).toEqual({ kind: 'scalar', value: 'b' });
    });

    test('with a static index selecting a non-literal item returns that item resolved, regardless of other items', () => {
      const result = resolveValue(consumerProp('SelectStaticIntoMixedList'), context);
      expect(result).toEqual({ kind: 'resourceRef', logicalId: 'MyBucket' });
    });

    test('with an out-of-bounds index resolves to unresolved', () => {
      const result = resolveValue(consumerProp('SelectOutOfBounds'), context);
      expect(result).toEqual({ kind: 'unresolved', reason: 'Fn::Select index 5 is out of bounds for a 2-item list' });
    });

    test('with a dynamic (non-literal) index resolves to unresolved', () => {
      const result = resolveValue(consumerProp('SelectDynamicIndex'), context);
      expect(result).toEqual({ kind: 'unresolved', reason: 'Fn::Select index is not statically determinable' });
    });
  });

  describe('non-intrinsic structure', () => {
    test('a plain nested object passes through recursively resolved, unchanged in shape', () => {
      const result = resolveValue(consumerProp('PlainNestedObject'), context);
      expect(result).toEqual({
        kind: 'object',
        entries: [
          { key: 'Foo', value: { kind: 'scalar', value: 'bar' } },
          { key: 'Baz', value: { kind: 'scalar', value: 3 } },
        ],
      });
    });

    test('a plain list passes through recursively resolved, unchanged in shape', () => {
      const result = resolveValue(consumerProp('PlainList'), context);
      expect(result).toEqual({ kind: 'list', items: [{ kind: 'scalar', value: 'x' }, { kind: 'scalar', value: 'y' }] });
    });
  });

  describe('integration: 2+ intrinsics combined in one property value', () => {
    test('Fn::Join of a Ref and a Fn::GetAtt keeps both references visible', () => {
      const result = resolveValue(consumerProp('IntegrationJoinOfRefAndGetAtt'), context);
      expect(result).toEqual({
        kind: 'list',
        items: [
          { kind: 'resourceRef', logicalId: 'MyBucket' },
          { kind: 'attributeRef', logicalId: 'MyBucket', attribute: 'Arn' },
        ],
      });
    });
  });

  describe('real-world fixture: examples/01-simple-lambda', () => {
    test('resolves Fn::GetAtt and Ref-to-parameter-without-default correctly', () => {
      const realTemplate = loadTemplate(examplePath('01-simple-lambda/template.yaml'));
      const realContext = buildResolutionContext(realTemplate);
      const props = getPath(realTemplate, 'Resources', 'LambdaFunction', 'Properties');

      expect(resolveValue(getEntry(props, 'Role'), realContext)).toEqual({
        kind: 'attributeRef',
        logicalId: 'LambdaRole',
        attribute: 'Arn',
      });

      const env = getPath(props, 'Environment', 'Variables');
      expect(resolveValue(getEntry(env, 'ENV'), realContext)).toEqual({ kind: 'parameterRef', name: 'EnvName' });
      expect(resolveValue(getEntry(env, 'TZ'), realContext)).toEqual({ kind: 'scalar', value: 'UTC' });
    });
  });
});
