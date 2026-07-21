import { describe, expect, test } from 'vitest';
import { assumedStackName } from '../stackName.js';

describe('assumedStackName', () => {
  test('falls back to the containing folder name when the filename stem is the generic word "template"', () => {
    expect(assumedStackName('/repo/examples/03-multi-stack-ecs-fargate/network-stack/template.yaml')).toBe('network-stack');
    expect(assumedStackName('/repo/examples/03-multi-stack-ecs-fargate/service-stack/template.yaml')).toBe('service-stack');
    expect(
      assumedStackName('/repo/examples/03-multi-stack-ecs-fargate/private-subnet-public-service/template.yaml'),
    ).toBe('private-subnet-public-service');
  });

  test('is case-insensitive when detecting the generic "template" stem', () => {
    expect(assumedStackName('/repo/some-stack/Template.YAML')).toBe('some-stack');
  });

  test('uses the filename stem, stripping a trailing .template suffix, when it is distinct', () => {
    expect(assumedStackName('/repo/examples/06-nested-stack-quickstart/root.template.yaml')).toBe('root');
    expect(assumedStackName('/repo/examples/06-nested-stack-quickstart/bastion-child.template.yaml')).toBe('bastion-child');
    expect(assumedStackName('/repo/examples/06-nested-stack-quickstart/vpc-child.template.yaml')).toBe('vpc-child');
  });

  test('uses the filename stem directly when there is no .template suffix and it is not generic', () => {
    expect(assumedStackName('/repo/examples/01-simple-lambda/lambda.yaml')).toBe('lambda');
  });

  test('falls back to the folder name for a generic stem regardless of extension (.json)', () => {
    expect(assumedStackName('/repo/examples/some-stack/template.json')).toBe('some-stack');
  });

  test('two different files with the same generic stem in different folders resolve to different names', () => {
    const a = assumedStackName('/repo/a/template.yaml');
    const b = assumedStackName('/repo/b/template.yaml');
    expect(a).not.toBe(b);
  });

  test('two different files with distinct, non-generic stems in the same folder resolve to different names', () => {
    const a = assumedStackName('/repo/shared-folder/root.template.yaml');
    const b = assumedStackName('/repo/shared-folder/bastion-child.template.yaml');
    expect(a).not.toBe(b);
  });

  test('works with Windows-style backslash paths', () => {
    expect(assumedStackName('C:\\repo\\examples\\network-stack\\template.yaml')).toBe('network-stack');
    expect(assumedStackName('C:\\repo\\examples\\06-nested-stack-quickstart\\root.template.yaml')).toBe('root');
  });
});
