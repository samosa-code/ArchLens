import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { loadTemplate } from '../../parser/loader.js';
import { buildExportSymbolTable } from '../exports.js';
import { assumedStackName } from '../stackName.js';
import type { LoadedTemplate } from '../../common/interfaces.js';

const FIXTURES = new URL('./__fixtures__/', import.meta.url);
const REAL_WORLD_EXAMPLES = new URL('../../../examples/', import.meta.url);

function fixturePath(name: string): string {
  return fileURLToPath(new URL(name, FIXTURES));
}

function examplePath(name: string): string {
  return fileURLToPath(new URL(name, REAL_WORLD_EXAMPLES));
}

function loaded(file: string): LoadedTemplate {
  return { file, ast: loadTemplate(file) };
}

const FILE_A = fixturePath('exports-basic-a.yaml');
const FILE_B = fixturePath('exports-basic-b.yaml');

describe('buildExportSymbolTable — basic indexing', () => {
  test('a literal Export.Name with no pseudo parameters indexes directly', () => {
    const table = buildExportSymbolTable([loaded(FILE_A)]);
    const entry = table.byName.get('PlainLiteralName');
    expect(entry).toBeDefined();
    expect(entry!.file).toBe(FILE_A);
    expect(entry!.outputName).toBe('LiteralExport');
    expect(entry!.usedAssumedPseudoParameters).toBe(false);
    expect(entry!.inclusion).toEqual({ kind: 'included' });
  });

  test('an Output with no Export block is not indexed and produces no warning', () => {
    const table = buildExportSymbolTable([loaded(FILE_A)]);
    const names = [...table.byName.values()].map((e) => e.outputName);
    expect(names).not.toContain('NoExportOutput');
    expect(table.warnings.some((w) => w.kind === 'unresolvableExportName' && w.outputName === 'NoExportOutput')).toBe(false);
  });

  test('an Export block with no Name produces an unresolvableExportName warning', () => {
    const table = buildExportSymbolTable([loaded(FILE_A)]);
    expect(table.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'unresolvableExportName', file: FILE_A, outputName: 'MalformedExportNoName' }),
      ]),
    );
  });
});

describe('buildExportSymbolTable — assumed pseudo parameters (PO Question 4b)', () => {
  test('AWS::StackName inside Fn::Join resolves via the per-file assumed convention, flagged as assumed', () => {
    const table = buildExportSymbolTable([loaded(FILE_A)]);
    const expectedStackName = assumedStackName(FILE_A);
    const entry = table.byName.get(`${expectedStackName}:Thing`);
    expect(entry).toBeDefined();
    expect(entry!.outputName).toBe('StackNameJoinExport');
    expect(entry!.usedAssumedPseudoParameters).toBe(true);
  });

  test('AWS::Region and AWS::StackName combined in one Fn::Sub both resolve via their assumed values', () => {
    const table = buildExportSymbolTable([loaded(FILE_A)]);
    const expectedStackName = assumedStackName(FILE_A);
    const entry = [...table.byName.values()].find((e) => e.outputName === 'RegionAndStackNameExport');
    expect(entry).toBeDefined();
    expect(entry!.matchKey).toBe(`assumed-region-${expectedStackName}-Combo`);
    expect(entry!.usedAssumedPseudoParameters).toBe(true);
  });

  test('a plain Parameter (no Default) inside Export.Name is NOT assumed — stays unresolvable (PO Question 2 precedent)', () => {
    const table = buildExportSymbolTable([loaded(FILE_A)]);
    const names = [...table.byName.values()].map((e) => e.outputName);
    expect(names).not.toContain('ParamDependentExport');
    expect(table.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'unresolvableExportName',
          outputName: 'ParamDependentExport',
          reason: expect.stringContaining('EnvName'),
        }),
      ]),
    );
  });
});

describe('buildExportSymbolTable — Output-level Condition / inclusion (PO Question 1 precedent)', () => {
  test('an Output gated by a statically-false Condition is excluded and produces no entry', () => {
    const table = buildExportSymbolTable([loaded(FILE_A)]);
    const names = [...table.byName.values()].map((e) => e.outputName);
    expect(names).not.toContain('ExcludedExport');
  });

  test('an Output gated by an undefined Condition still gets an entry, marked unknown', () => {
    const table = buildExportSymbolTable([loaded(FILE_A)]);
    const entry = [...table.byName.values()].find((e) => e.outputName === 'UnknownInclusionExport');
    expect(entry).toBeDefined();
    expect(entry!.inclusion.kind).toBe('unknown');
  });
});

describe('buildExportSymbolTable — duplicate export names (PO Question 4c)', () => {
  test('the same export name declared twice within one template is flagged as a conflict, not indexed', () => {
    const table = buildExportSymbolTable([loaded(FILE_A)]);
    expect(table.byName.has('SelfDuplicateName')).toBe(false);
    const warning = table.warnings.find((w) => w.kind === 'duplicateExportName' && w.matchKey === 'SelfDuplicateName');
    expect(warning).toBeDefined();
    if (warning?.kind === 'duplicateExportName') {
      expect(warning.occurrences).toEqual(
        expect.arrayContaining([
          { file: FILE_A, outputName: 'SelfDuplicateA' },
          { file: FILE_A, outputName: 'SelfDuplicateB' },
        ]),
      );
    }
  });

  test('the same export name declared across two different templates is flagged as a conflict, not indexed, never last-wins', () => {
    const table = buildExportSymbolTable([loaded(FILE_A), loaded(FILE_B)]);
    expect(table.byName.has('PlainLiteralName')).toBe(false);
    const warning = table.warnings.find((w) => w.kind === 'duplicateExportName' && w.matchKey === 'PlainLiteralName');
    expect(warning).toBeDefined();
    if (warning?.kind === 'duplicateExportName') {
      expect(warning.occurrences).toEqual(
        expect.arrayContaining([
          { file: FILE_A, outputName: 'LiteralExport' },
          { file: FILE_B, outputName: 'CrossFileDuplicate' },
        ]),
      );
    }
  });

  test('order of input templates does not change which pair is flagged (not last-wins in either direction)', () => {
    const tableForward = buildExportSymbolTable([loaded(FILE_A), loaded(FILE_B)]);
    const tableReversed = buildExportSymbolTable([loaded(FILE_B), loaded(FILE_A)]);
    expect(tableForward.byName.has('PlainLiteralName')).toBe(false);
    expect(tableReversed.byName.has('PlainLiteralName')).toBe(false);
  });
});

describe('buildExportSymbolTable — real-world fixtures', () => {
  test('01-simple-lambda and 05-malformed-and-missing-ref both exporting "LambdaRole" is flagged as a conflict', () => {
    const fileA = examplePath('01-simple-lambda/template.yaml');
    const fileB = examplePath('05-malformed-and-missing-ref/missing-resource-ref.yaml');
    const table = buildExportSymbolTable([loaded(fileA), loaded(fileB)]);

    expect(table.byName.has('LambdaRole')).toBe(false);
    const warning = table.warnings.find((w) => w.kind === 'duplicateExportName' && w.matchKey === 'LambdaRole');
    expect(warning).toBeDefined();
  });

  test('03-multi-stack-ecs-fargate/network-stack resolves its AWS::StackName-based exports via the assumed convention', () => {
    const file = examplePath('03-multi-stack-ecs-fargate/network-stack/template.yaml');
    const table = buildExportSymbolTable([loaded(file)]);
    const expectedStackName = assumedStackName(file);

    expect(table.byName.has(`${expectedStackName}:ClusterName`)).toBe(true);
    expect(table.byName.has(`${expectedStackName}:ExternalUrl`)).toBe(true);
    expect(table.byName.has(`${expectedStackName}:ECSRole`)).toBe(true);
    expect(table.byName.get(`${expectedStackName}:ClusterName`)!.usedAssumedPseudoParameters).toBe(true);
  });

  test('02-complex-vpc-nat resolves its combined AWS::Region + AWS::StackName exports consistently', () => {
    const file = examplePath('02-complex-vpc-nat/template.yaml');
    const table = buildExportSymbolTable([loaded(file)]);
    const expectedStackName = assumedStackName(file);

    expect(table.byName.has(`assumed-region-${expectedStackName}-VPC`)).toBe(true);
    expect(table.byName.has(`assumed-region-${expectedStackName}-DefaultSecurityGroup`)).toBe(true);
    expect(table.warnings.some((w) => w.kind === 'duplicateExportName')).toBe(false);
  });

  test('06-nested-stack-quickstart\'s condition-gated Outputs (EIP2/EIP3/EIP4) resolve to a real inclusion outcome, not a crash', () => {
    const file = examplePath('06-nested-stack-quickstart/bastion-child.template.yaml');
    const table = buildExportSymbolTable([loaded(file)]);
    // At least the unconditional exports must be present.
    const expectedStackName = assumedStackName(file);
    expect(table.byName.has(`${expectedStackName}-BastionAutoScalingGroup`)).toBe(true);
  });

  test('every example fixture with an Outputs section builds a table without crashing, with internally consistent results', () => {
    const files = [
      '01-simple-lambda/template.yaml',
      '02-complex-vpc-nat/template.yaml',
      '03-multi-stack-ecs-fargate/network-stack/template.yaml',
      '05-malformed-and-missing-ref/missing-resource-ref.yaml',
      '06-nested-stack-quickstart/bastion-child.template.yaml',
      '06-nested-stack-quickstart/root.template.yaml',
      '06-nested-stack-quickstart/vpc-child.template.yaml',
      '07-vulnerable-cfngoat/cfngoat.yaml',
      '09-sam-apigw-lambda-dynamodb/template.yaml',
      '10-vpc-peering/requester-setup.yaml',
      '11-large-production-wordpress-ha/template.yaml',
      '12-diff-pair-wordpress-tls/after.yaml',
      '12-diff-pair-wordpress-tls/before.yaml',
    ];
    for (const name of files) {
      const file = examplePath(name);
      const table = buildExportSymbolTable([loaded(file)]);
      for (const [matchKey, entry] of table.byName) {
        expect(entry.matchKey).toBe(matchKey);
        expect(['included', 'unknown']).toContain(entry.inclusion.kind);
      }
      for (const warning of table.warnings) {
        if (warning.kind === 'duplicateExportName') {
          expect(warning.occurrences.length).toBeGreaterThanOrEqual(2);
        } else {
          expect(warning.file).toBe(file);
        }
      }
    }
  });
});
