import { fileURLToPath } from 'node:url';
import { describe, expect, test, beforeAll } from 'vitest';
import { loadTemplate } from '../loader.js';
import { buildResolutionContext, resolveValue } from '../intrinsics.js';
import { getEntry, getPath } from './astTestHelpers.js';
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

    test('with a static index into Fn::GetAZs resolves to an availabilityZoneRef, not unresolved', () => {
      const result = resolveValue(consumerProp('SelectFromGetAZsBare'), context);
      expect(result).toEqual({ kind: 'availabilityZoneRef', region: { kind: 'scalar', value: '' }, index: 0 });
    });

    test('with a static index into Fn::GetAZs {Ref: AWS::Region} preserves the region as a pseudoParameterRef', () => {
      const result = resolveValue(consumerProp('SelectFromGetAZsWithRegionRef'), context);
      expect(result).toEqual({
        kind: 'availabilityZoneRef',
        region: { kind: 'pseudoParameterRef', name: 'AWS::Region' },
        index: 2,
      });
    });

    test('with a dynamic index into Fn::GetAZs still resolves to unresolved (index is checked before the list)', () => {
      const result = resolveValue(consumerProp('SelectDynamicIndexFromGetAZs'), context);
      expect(result).toEqual({ kind: 'unresolved', reason: 'Fn::Select index is not statically determinable' });
    });
  });

  describe('Fn::GetAZs', () => {
    test('bare form (empty string region) resolves to an availabilityZonesRef with a literal empty-string region', () => {
      const result = resolveValue(consumerProp('GetAZsBareForm'), context);
      expect(result).toEqual({ kind: 'availabilityZonesRef', region: { kind: 'scalar', value: '' } });
    });

    test('with an explicit AWS::Region Ref preserves it as a pseudoParameterRef, never guessed', () => {
      const result = resolveValue(consumerProp('GetAZsWithRegionRef'), context);
      expect(result).toEqual({ kind: 'availabilityZonesRef', region: { kind: 'pseudoParameterRef', name: 'AWS::Region' } });
    });

    test('with a literal region name resolves to an availabilityZonesRef carrying that literal', () => {
      const result = resolveValue(consumerProp('GetAZsWithLiteralRegion'), context);
      expect(result).toEqual({ kind: 'availabilityZonesRef', region: { kind: 'scalar', value: 'us-west-2' } });
    });
  });

  describe('Fn::Split', () => {
    test('with a literal delimiter and literal source string computes the actual split', () => {
      const result = resolveValue(consumerProp('SplitFullyStatic'), context);
      expect(result).toEqual({
        kind: 'list',
        items: [
          { kind: 'scalar', value: 'a' },
          { kind: 'scalar', value: 'b' },
          { kind: 'scalar', value: 'c' },
        ],
      });
    });

    test('with a non-literal source string resolves to unresolved', () => {
      const result = resolveValue(consumerProp('SplitOfNonLiteralSource'), context);
      expect(result).toEqual({ kind: 'unresolved', reason: 'Fn::Split source string is not statically determinable' });
    });

    test('with a non-literal delimiter resolves to unresolved', () => {
      const result = resolveValue(consumerProp('SplitWithNonLiteralDelimiter'), context);
      expect(result).toEqual({ kind: 'unresolved', reason: 'Fn::Split delimiter is not statically determinable' });
    });

    test('Fn::Select over a fully-static Fn::Split picks the literal item', () => {
      const result = resolveValue(consumerProp('SelectFromSplit'), context);
      expect(result).toEqual({ kind: 'scalar', value: 'b' });
    });
  });

  describe('Fn::Sub', () => {
    test('with no placeholders resolves to the literal string unchanged', () => {
      const result = resolveValue(consumerProp('SubLiteralOnly'), context);
      expect(result).toEqual({ kind: 'scalar', value: 'plain text, no placeholders' });
    });

    test('with an implicit Ref placeholder to a resource does not collapse, keeping the reference visible', () => {
      const result = resolveValue(consumerProp('SubWithImplicitRef'), context);
      expect(result).toEqual({
        kind: 'list',
        items: [{ kind: 'scalar', value: 'bucket is ' }, { kind: 'resourceRef', logicalId: 'MyBucket' }],
      });
    });

    test('with an implicit Fn::GetAtt placeholder (dotted) does not collapse, keeping the reference visible', () => {
      const result = resolveValue(consumerProp('SubWithImplicitGetAtt'), context);
      expect(result).toEqual({
        kind: 'list',
        items: [{ kind: 'scalar', value: 'arn is ' }, { kind: 'attributeRef', logicalId: 'MyBucket', attribute: 'Arn' }],
      });
    });

    test('with a placeholder resolving to a literal (parameter Default) fully collapses to one string', () => {
      const result = resolveValue(consumerProp('SubWithParamDefaultCollapses'), context);
      expect(result).toEqual({ kind: 'scalar', value: 'type is t2.micro' });
    });

    test('with 2+ embedded references, one literal and one not, collapses what it can and preserves the rest', () => {
      const result = resolveValue(consumerProp('SubWithTwoEmbeddedRefs'), context);
      expect(result).toEqual({
        kind: 'list',
        items: [
          { kind: 'scalar', value: 't2.micro' },
          { kind: 'scalar', value: '-' },
          { kind: 'parameterRef', name: 'EnvName' },
        ],
      });
    });

    test('${!Name} is an escape for a literal ${Name}, not a variable reference', () => {
      const result = resolveValue(consumerProp('SubWithEscapedLiteral'), context);
      expect(result).toEqual({ kind: 'scalar', value: 'literal ${NotAVar} end' });
    });

    test('long form resolves placeholders against the explicit substitution map, including nested intrinsics', () => {
      const result = resolveValue(consumerProp('SubWithSubstitutionMap'), context);
      expect(result).toEqual({
        kind: 'list',
        items: [{ kind: 'scalar', value: 'value is ' }, { kind: 'attributeRef', logicalId: 'MyBucket', attribute: 'Arn' }],
      });
    });
  });

  describe('Fn::FindInMap', () => {
    test('with fully static arguments resolves to the mapped literal value', () => {
      const result = resolveValue(consumerProp('FindInMapStatic'), context);
      expect(result).toEqual({ kind: 'scalar', value: 'ami-111' });
    });

    test('with a dynamic top-level key resolves to unresolved', () => {
      const result = resolveValue(consumerProp('FindInMapDynamicTopKey'), context);
      expect(result).toEqual({ kind: 'unresolved', reason: 'Fn::FindInMap top-level key is not statically determinable' });
    });

    test('referencing an undeclared mapping resolves to unresolved', () => {
      const result = resolveValue(consumerProp('FindInMapUndeclaredMap'), context);
      expect(result).toEqual({ kind: 'unresolved', reason: 'Fn::FindInMap references undeclared mapping "NoSuchMap"' });
    });

    test('with a missing top-level key resolves to unresolved', () => {
      const result = resolveValue(consumerProp('FindInMapMissingTopKey'), context);
      expect(result).toEqual({
        kind: 'unresolved',
        reason: 'Fn::FindInMap top-level key "eu-west-1" not found in mapping "RegionMap"',
      });
    });

    test('with a missing second-level key resolves to unresolved', () => {
      const result = resolveValue(consumerProp('FindInMapMissingSecondKey'), context);
      expect(result).toEqual({
        kind: 'unresolved',
        reason: 'Fn::FindInMap second-level key "CidrList" not found under "us-east-1" in mapping "RegionMap"',
      });
    });

    test('with a list-valued mapping entry resolves to a list, not just scalars', () => {
      // QA audit gap: every other FindInMap test resolves to a scalar or
      // to unresolved — this is the only one confirming a mapping value
      // that's itself a YAML/JSON list (CidrList under us-west-2) comes
      // back as a proper `list` ResolvedValue, not silently coerced or
      // truncated to its first element.
      const result = resolveValue(consumerProp('FindInMapListValue'), context);
      expect(result).toEqual({
        kind: 'list',
        items: [{ kind: 'scalar', value: '10.0.0.0/16' }, { kind: 'scalar', value: '10.1.0.0/16' }],
      });
    });
  });

  describe('Fn::ImportValue', () => {
    test('with a literal export name tags it as a pending cross-stack reference', () => {
      const result = resolveValue(consumerProp('ImportValueLiteral'), context);
      expect(result).toEqual({
        kind: 'importValueRef',
        exportName: { kind: 'scalar', value: 'SomeExportName' },
      });
    });

    test('with a fully-static Fn::Join export name resolves the export name to one literal string', () => {
      const result = resolveValue(consumerProp('ImportValueJoinExpr'), context);
      expect(result).toEqual({
        kind: 'importValueRef',
        exportName: { kind: 'scalar', value: 't2.micro:suffix' },
      });
    });

    test('with a non-static export name still tags it, exposing whatever did resolve', () => {
      const result = resolveValue(consumerProp('ImportValueNonStaticExpr'), context);
      expect(result).toEqual({
        kind: 'importValueRef',
        exportName: {
          kind: 'list',
          items: [{ kind: 'parameterRef', name: 'EnvName' }, { kind: 'scalar', value: 'suffix' }],
        },
      });
    });
  });

  describe('Fn::GetStackOutput', () => {
    test('is recognized and reported unresolved, not silently passed through as a plain object', () => {
      const result = resolveValue(consumerProp('GetStackOutputCall'), context);
      expect(result).toEqual({
        kind: 'unresolved',
        reason: 'Fn::GetStackOutput is not yet supported',
      });
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

      expect(resolveValue(getEntry(props, 'FunctionName'), realContext)).toEqual({
        kind: 'list',
        items: [{ kind: 'scalar', value: 'lambda-function-' }, { kind: 'parameterRef', name: 'EnvName' }],
      });
    });
  });

  describe('real-world fixture: examples/02-complex-vpc-nat', () => {
    test('resolves Fn::FindInMap against a real Mappings block', () => {
      const realTemplate = loadTemplate(examplePath('02-complex-vpc-nat/template.yaml'));
      const realContext = buildResolutionContext(realTemplate);
      const vpcProps = getPath(realTemplate, 'Resources', 'VPC', 'Properties');

      expect(resolveValue(getEntry(vpcProps, 'CidrBlock'), realContext)).toEqual({
        kind: 'scalar',
        value: '10.0.0.0/16',
      });
    });
  });

  describe('real-world fixture: examples/03-multi-stack-ecs-fargate', () => {
    test('resolves a real Fn::ImportValue + Fn::Join export name to one literal string', () => {
      const realTemplate = loadTemplate(examplePath('03-multi-stack-ecs-fargate/service-stack/template.yaml'));
      const realContext = buildResolutionContext(realTemplate);
      const taskDefProps = getPath(realTemplate, 'Resources', 'TaskDefinition', 'Properties');

      expect(resolveValue(getEntry(taskDefProps, 'ExecutionRoleArn'), realContext)).toEqual({
        kind: 'importValueRef',
        exportName: { kind: 'scalar', value: 'production:ECSTaskExecutionRole' },
      });
    });
  });

  describe('QA audit: real-world fixture: examples/08-cdk-synthesized', () => {
    // A real `cdk synth` build artifact (not hand-written CFN) — different
    // authoring patterns than anything AWS's own sample templates use,
    // e.g. Fn::Select whose list argument is a Ref to a parameter rather
    // than an inline array literal.
    let realTemplate: AstNode;
    let realContext: ResolutionContext;

    beforeAll(() => {
      realTemplate = loadTemplate(examplePath('08-cdk-synthesized/template.json'));
      realContext = buildResolutionContext(realTemplate);
    });

    test('Fn::Select whose list argument is a Ref (not a literal array) resolves to unresolved, not a crash or a guess', () => {
      // Conditions.isPrincipalsEmpty: !Equals [!Select [0, !Ref Principals], ""]
      // Principals is a CommaDelimitedList parameter with Default "" — its
      // resolved value is a literal *scalar* string, not a list, so
      // Fn::Select's list argument here is a {Ref: Principals} object node,
      // not an array node, and can't be indexed into.
      const conditions = getPath(realTemplate, 'Conditions');
      const isPrincipalsEmptyExpr = getEntry(conditions, 'isPrincipalsEmpty');
      const equalsArgs = getEntry(isPrincipalsEmptyExpr, 'Fn::Equals');
      if (equalsArgs.kind !== 'array') throw new Error('expected Fn::Equals to be an array');
      const selectNode = equalsArgs.items[0]!;

      const result = resolveValue(selectNode, realContext);
      expect(result).toEqual({
        kind: 'unresolved',
        reason: 'Fn::Select list argument is not statically determinable',
      });
    });

    test('a real Fn::FindInMap + Fn::Equals chain fully collapses to a literal true', () => {
      // Conditions.AnonymizedMetricsEnabled:
      //   !Equals [!FindInMap [Send, AnonymousUsage, Data], "Yes"]
      // Mappings.Send.AnonymousUsage.Data is the literal "Yes".
      const conditions = getPath(realTemplate, 'Conditions');
      const anonymizedMetricsExpr = getEntry(conditions, 'AnonymizedMetricsEnabled');
      const equalsArgs = getEntry(anonymizedMetricsExpr, 'Fn::Equals');
      if (equalsArgs.kind !== 'array') throw new Error('expected Fn::Equals to be an array');
      const findInMapNode = equalsArgs.items[0]!;

      const result = resolveValue(findInMapNode, realContext);
      expect(result).toEqual({ kind: 'scalar', value: 'Yes' });
    });
  });
});
