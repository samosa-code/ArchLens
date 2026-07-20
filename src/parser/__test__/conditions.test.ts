import { fileURLToPath } from 'node:url';
import { describe, expect, test, beforeAll } from 'vitest';
import { loadTemplate } from '../loader.js';
import { buildResolutionContext, resolveValue } from '../intrinsics.js';
import { evaluateConditions, resourceInclusion } from '../conditions.js';
import { getEntry, getPath } from './astTestHelpers.js';
import type { AstNode, ConditionValue } from '../../common/types.js';
import type { ResolutionContext } from '../../common/interfaces.js';

const FIXTURES = new URL('./__fixtures__/', import.meta.url);
const REAL_WORLD_EXAMPLES = new URL('../../../examples/', import.meta.url);

function fixturePath(name: string): string {
  return fileURLToPath(new URL(name, FIXTURES));
}

function examplePath(name: string): string {
  return fileURLToPath(new URL(name, REAL_WORLD_EXAMPLES));
}

describe('Ticket 1.5: Conditions block evaluation', () => {
  let template: AstNode;
  let context: ResolutionContext;
  let conditionResults: Map<string, ConditionValue>;

  beforeAll(() => {
    template = loadTemplate(fixturePath('conditions-basic.yaml'));
    context = buildResolutionContext(template);
    conditionResults = evaluateConditions(template, context);
  });

  function resource(logicalId: string): AstNode {
    return getEntry(getPath(template, 'Resources'), logicalId);
  }

  describe('evaluateConditions', () => {
    test('a condition resolvable from a parameter Default and a literal evaluates true', () => {
      expect(conditionResults.get('IsProd')).toEqual({ kind: 'true' });
    });

    test('a resolvable comparison that does not match evaluates false', () => {
      expect(conditionResults.get('IsDev')).toEqual({ kind: 'false' });
    });

    test('a condition depending on a parameter with no Default evaluates unknown', () => {
      const result = conditionResults.get('IsUnknown');
      expect(result?.kind).toBe('unknown');
    });

    test('Fn::Not inverts true to false and false to true', () => {
      expect(conditionResults.get('NotProd')).toEqual({ kind: 'false' });
    });

    test('Fn::And of two resolvable conditions evaluates correctly', () => {
      expect(conditionResults.get('ProdAndDev')).toEqual({ kind: 'false' });
    });

    test('Fn::And short-circuits to false when one operand is false, even if another is unknown', () => {
      const result = conditionResults.get('UnknownAndDev');
      expect(result).toEqual({ kind: 'false' });
    });

    test('Fn::Or short-circuits to true when one operand is true, even if another is unknown', () => {
      const result = conditionResults.get('ProdOrUnknown');
      expect(result).toEqual({ kind: 'true' });
    });

    test('Fn::Or of a false and an unknown operand (neither decisive) evaluates unknown', () => {
      const result = conditionResults.get('DevOrUnknown');
      expect(result?.kind).toBe('unknown');
    });
  });

  describe('resourceInclusion', () => {
    test('a resource with no Condition attribute is always included', () => {
      expect(resourceInclusion(resource('UnconditionalBucket'), conditionResults)).toEqual({ kind: 'included' });
    });

    test('a resource gated by a condition that resolves true is included', () => {
      expect(resourceInclusion(resource('ProdOnlyBucket'), conditionResults)).toEqual({ kind: 'included' });
    });

    test('a resource gated by a condition that resolves false is excluded', () => {
      expect(resourceInclusion(resource('DevOnlyBucket'), conditionResults)).toEqual({ kind: 'excluded' });
    });

    test('a resource gated by an unresolvable condition is unknown — never omitted, never assumed true', () => {
      const result = resourceInclusion(resource('UnknownGatedBucket'), conditionResults);
      expect(result.kind).toBe('unknown');
      expect(result).toHaveProperty('reason');
    });

    test('a resource referencing an undefined condition name is unknown', () => {
      const result = resourceInclusion(resource('UndefinedConditionBucket'), conditionResults);
      expect(result).toEqual({
        kind: 'unknown',
        reason: 'resource references undefined condition "NoSuchCondition"',
      });
    });
  });

  describe('Fn::If (property-level branch selection)', () => {
    // Fn::If needs the evaluated conditions merged into the context —
    // buildResolutionContext() alone leaves `conditions` empty. Computed in
    // a nested beforeAll (not inline here) since `context`/`conditionResults`
    // aren't assigned until the outer beforeAll runs, which happens after
    // this describe body itself executes.
    let ifContext: ResolutionContext;
    beforeAll(() => {
      ifContext = { ...context, conditions: conditionResults };
    });

    function ifConsumerProp(key: string): AstNode {
      return getPath(template, 'Resources', 'IfConsumer', 'Properties', key);
    }

    test('with a true condition resolves the true branch', () => {
      const result = resolveValue(ifConsumerProp('ValueIfProdTrue'), ifContext);
      expect(result).toEqual({ kind: 'scalar', value: 'prod-value' });
    });

    test('with a false condition resolves the false branch', () => {
      const result = resolveValue(ifConsumerProp('ValueIfDevFalse'), ifContext);
      expect(result).toEqual({ kind: 'scalar', value: 'not-dev-value' });
    });

    test('with an unresolvable condition resolves to unresolved, never guessing a branch', () => {
      const result = resolveValue(ifConsumerProp('ValueIfUnknown'), ifContext);
      expect(result).toEqual({
        kind: 'unresolved',
        reason: 'Fn::If condition "IsUnknown" is not statically determinable',
      });
    });

    test('referencing an undefined condition name resolves to unresolved', () => {
      const result = resolveValue(ifConsumerProp('ValueIfUndefinedCondition'), ifContext);
      expect(result).toEqual({
        kind: 'unresolved',
        reason: 'Fn::If references undefined condition "NoSuchCondition"',
      });
    });
  });

  describe('real-world fixture: examples/03-multi-stack-ecs-fargate', () => {
    test('resolves a real Fn::Not/Fn::Equals condition and the Fn::If that depends on it', () => {
      const realTemplate = loadTemplate(examplePath('03-multi-stack-ecs-fargate/service-stack/template.yaml'));
      const realContext = buildResolutionContext(realTemplate);
      const realConditions = evaluateConditions(realTemplate, realContext);

      // HasCustomRole: !Not [!Equals [!Ref Role, ""]] — Role's Default is ""
      // (empty string), so Equals is true, and Not makes the condition false.
      expect(realConditions.get('HasCustomRole')).toEqual({ kind: 'false' });

      // TaskRoleArn: !If [HasCustomRole, !Ref Role, !Ref AWS::NoValue] —
      // HasCustomRole is false, so this should resolve to the NoValue branch.
      const taskDefProps = getPath(realTemplate, 'Resources', 'TaskDefinition', 'Properties');
      const fullContext: ResolutionContext = { ...realContext, conditions: realConditions };
      expect(resolveValue(getEntry(taskDefProps, 'TaskRoleArn'), fullContext)).toEqual({
        kind: 'pseudoParameterRef',
        name: 'AWS::NoValue',
      });
    });
  });

  describe('QA audit: real-world fixture: examples/06-nested-stack-quickstart', () => {
    // A genuine, unmodified production AWS Quick Start template — richer
    // condition/Fn::If usage than any hand-written fixture: Fn::If picking
    // between Fn::GetAtt on a *nested stack's* Outputs, and Fn::If wrapping
    // Fn::Sub with a pseudo-parameter placeholder.
    let realTemplate: AstNode;
    let realContext: ResolutionContext;
    let realConditions: Map<string, ConditionValue>;
    let fullContext: ResolutionContext;

    beforeAll(() => {
      realTemplate = loadTemplate(examplePath('06-nested-stack-quickstart/root.template.yaml'));
      realContext = buildResolutionContext(realTemplate);
      realConditions = evaluateConditions(realTemplate, realContext);
      fullContext = { ...realContext, conditions: realConditions };
    });

    test('NeedsEip: !Not [!Equals [!Ref RemoteAccessCIDR, disabled-onlyssmaccess]] evaluates false from the parameter Default', () => {
      // RemoteAccessCIDR's Default is literally "disabled-onlyssmaccess",
      // so Equals is true and Not makes the condition false.
      expect(realConditions.get('NeedsEip')).toEqual({ kind: 'false' });
    });

    test('UsingDefaultBucket: !Equals [!Ref QSS3BucketName, aws-quickstart] evaluates true from the parameter Default', () => {
      expect(realConditions.get('UsingDefaultBucket')).toEqual({ kind: 'true' });
    });

    test('Fn::If selects between Fn::GetAtt on a nested stack\'s Outputs based on a real condition', () => {
      // BastionStack.Properties.Parameters.PublicSubnet2ID:
      //   !If [NeedsEip, !GetAtt VPCStack.Outputs.PublicSubnet2ID,
      //                  !GetAtt VPCStack.Outputs.PrivateSubnet2AID]
      // NeedsEip is false, so this must resolve to the false branch —
      // GetAtt's first-dot-only split means "Outputs.PrivateSubnet2AID" is
      // one attribute name, not further parsed.
      const bastionParams = getPath(realTemplate, 'Resources', 'BastionStack', 'Properties', 'Parameters');
      const result = resolveValue(getEntry(bastionParams, 'PublicSubnet2ID'), fullContext);
      expect(result).toEqual({
        kind: 'attributeRef',
        logicalId: 'VPCStack',
        attribute: 'Outputs.PrivateSubnet2AID',
      });
    });

    test('Fn::If wrapping Fn::Sub with an AWS::Region pseudo-parameter placeholder does not collapse, but resolves correctly', () => {
      // VPCStack.Properties.TemplateURL is a long-form Fn::Sub whose
      // substitution map's S3Bucket entry is:
      //   !If [UsingDefaultBucket, !Sub 'aws-quickstart-${AWS::Region}', !Ref QSS3BucketName]
      // UsingDefaultBucket is true, so this resolves to the Sub branch,
      // which can't fully collapse (AWS::Region is deploy-time-only).
      const templateUrlNode = getPath(realTemplate, 'Resources', 'VPCStack', 'Properties', 'TemplateURL');
      const subArgs = getEntry(templateUrlNode, 'Fn::Sub');
      if (subArgs.kind !== 'array') throw new Error('expected Fn::Sub long form');
      const substitutionMap = subArgs.items[1]!;
      const s3BucketExpr = getEntry(substitutionMap, 'S3Bucket');

      const result = resolveValue(s3BucketExpr, fullContext);
      expect(result).toEqual({
        kind: 'list',
        items: [{ kind: 'scalar', value: 'aws-quickstart-' }, { kind: 'pseudoParameterRef', name: 'AWS::Region' }],
      });
    });
  });

  describe('QA audit: real-world fixture: examples/11-large-production-wordpress-ha', () => {
    // Production template with 17 conditions, including forward references
    // and condition-to-condition chaining — a genuine stress test for
    // evaluateConditions()'s memoization/lazy-evaluation design.
    let realTemplate: AstNode;
    let realContext: ResolutionContext;
    let realConditions: Map<string, ConditionValue>;
    let fullContext: ResolutionContext;

    beforeAll(() => {
      realTemplate = loadTemplate(examplePath('11-large-production-wordpress-ha/template.yaml'));
      realContext = buildResolutionContext(realTemplate);
      realConditions = evaluateConditions(realTemplate, realContext);
      fullContext = { ...realContext, conditions: realConditions };
    });

    test('a condition referencing another condition defined AFTER it in the block (forward reference) still resolves correctly', () => {
      // HasEFSProvisionedThroughput: !Not [!Condition HasNotEFSProvisionedThroughput]
      // — defined BEFORE HasNotEFSProvisionedThroughput in the YAML source.
      // EFSProvisionedThroughputInMibps's Default is the *number* 0, compared
      // against the *string* '0' — Fn::Equals must coerce, not type-match.
      expect(realConditions.get('HasNotEFSProvisionedThroughput')).toEqual({ kind: 'true' });
      expect(realConditions.get('HasEFSProvisionedThroughput')).toEqual({ kind: 'false' });
    });

    test('Fn::And short-circuits to false against real data when one operand is false', () => {
      // HasAlertTopicAndNotEFSProvisionedThroughput:
      //   !And [!Condition HasAlertTopic, !Condition HasNotEFSProvisionedThroughput]
      // HasAlertTopic is false (ParentAlertStack's Default is ''), so the
      // AND is false even though HasNotEFSProvisionedThroughput is true.
      expect(realConditions.get('HasAlertTopic')).toEqual({ kind: 'false' });
      expect(realConditions.get('HasAlertTopicAndNotEFSProvisionedThroughput')).toEqual({ kind: 'false' });
    });

    test('a condition chain through Fn::FindInMap with a pseudo-parameter key resolves to unknown, not a guess', () => {
      // HasCloudFrontPrefixList: !Not [!Equals [!FindInMap [RegionMap, !Ref AWS::Region, PrefixListCloudFront], '']]
      // AWS::Region is deploy-time-only, so FindInMap's top-level key isn't
      // static, so Equals is unknown, so both this and the condition that
      // references it (HasNotCloudFrontPrefixList) must stay unknown too —
      // not collapse to a guessed true/false.
      expect(realConditions.get('HasCloudFrontPrefixList')?.kind).toBe('unknown');
      expect(realConditions.get('HasNotCloudFrontPrefixList')?.kind).toBe('unknown');
    });

    test('Fn::If resolves to the AWS::NoValue branch on real data — the actual "omit this optional property" pattern', () => {
      // WebServerIAMRole.Properties.PermissionsBoundary:
      //   !If [HasPermissionsBoundary, !Ref PermissionsBoundary, !Ref 'AWS::NoValue']
      // PermissionsBoundary's Default is '', so HasPermissionsBoundary is
      // false, so this resolves to AWS::NoValue.
      expect(realConditions.get('HasPermissionsBoundary')).toEqual({ kind: 'false' });

      const roleProps = getPath(realTemplate, 'Resources', 'WebServerIAMRole', 'Properties');
      const result = resolveValue(getEntry(roleProps, 'PermissionsBoundary'), fullContext);
      expect(result).toEqual({ kind: 'pseudoParameterRef', name: 'AWS::NoValue' });
    });
  });

  describe('QA audit: real-world fixture: examples/10-vpc-peering (deep condition-to-condition cascade)', () => {
    test('a 5-level Fn::Or cascade (2..6RouteTableCondition), each with 2-5 operands and no decisive value anywhere, resolves unknown at every level', () => {
      // NumberOfRouteTables has no Default, so 6RouteTableCondition (the
      // base case, !Equals [!Ref NumberOfRouteTables, 6]) is unknown, and
      // every level above it is Fn::Or-ing that unknown together with more
      // unknowns (2-5 operands per level) — never a `true`/`false` to
      // short-circuit on. This is a real stress test for evaluateConditions()'s
      // memoized recursion at actual depth (5 levels, not a toy 2-level
      // example), and for Fn::Or's "no operand is decisive" path with more
      // than 2 operands.
      const realTemplate = loadTemplate(examplePath('10-vpc-peering/peering-updates.yaml'));
      const realContext = buildResolutionContext(realTemplate);
      const realConditions = evaluateConditions(realTemplate, realContext);

      for (const name of ['2RouteTableCondition', '3RouteTableCondition', '4RouteTableCondition', '5RouteTableCondition', '6RouteTableCondition']) {
        expect(realConditions.get(name)?.kind, `${name} should be unknown`).toBe('unknown');
      }
    });
  });
});
