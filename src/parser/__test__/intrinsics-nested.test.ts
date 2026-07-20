import { fileURLToPath } from 'node:url';
import { describe, expect, test, beforeAll } from 'vitest';
import { loadTemplate } from '../loader.js';
import { buildResolutionContext, resolveValue } from '../intrinsics.js';
import { getPath } from './astTestHelpers.js';
import type { AstNode } from '../../common/types.js';
import type { ResolutionContext } from '../../common/interfaces.js';

const FIXTURES = new URL('./__fixtures__/', import.meta.url);

function fixturePath(name: string): string {
  return fileURLToPath(new URL(name, FIXTURES));
}

/**
 * Dedicated fixture/tests for Ticket 1.4: arbitrary intrinsic nesting depth.
 * Each function's own resolution is already unit-tested in
 * `intrinsics.test.ts` — these tests exist to prove *composition*: that
 * resolving one function correctly threads through 3+ levels of others
 * nested inside it, rather than only working one layer deep.
 */
describe('resolveValue: arbitrary intrinsic nesting (Ticket 1.4)', () => {
  let template: AstNode;
  let context: ResolutionContext;

  beforeAll(() => {
    template = loadTemplate(fixturePath('intrinsics-nested.yaml'));
    context = buildResolutionContext(template);
  });

  function consumerProp(key: string): AstNode {
    return getPath(template, 'Resources', 'Consumer', 'Properties', key);
  }

  test('Fn::Select > Fn::Join > [Fn::FindInMap, Fn::GetAtt] resolves 4 levels deep', () => {
    const result = resolveValue(consumerProp('SelectOfJoinOfFindInMapAndGetAtt'), context);

    // The Join can't fully collapse (GetAtt isn't a literal), so Select's
    // pick surfaces that partial result rather than a plain string — proves
    // Select correctly delegates to whatever its selected item resolves to,
    // even when that item is itself a multi-level nested call.
    expect(result).toEqual({
      kind: 'list',
      items: [{ kind: 'scalar', value: 'ami-111' }, { kind: 'attributeRef', logicalId: 'MyBucket', attribute: 'Arn' }],
    });
  });

  test('Fn::Sub > Fn::Join > [Fn::FindInMap, Ref-with-Default] fully collapses through 3 levels', () => {
    const result = resolveValue(consumerProp('SubOfJoinOfFindInMapAndRef'), context);

    // Every leaf here is statically known, so collapsing should propagate
    // all the way up: FindInMap -> literal, Ref -> literal (via Default),
    // Join -> literal (both parts literal), Sub -> literal (its one
    // placeholder is literal) = one final plain string, not a partial list.
    expect(result).toEqual({ kind: 'scalar', value: 'result: ami-111-t2.micro' });
  });

  test('Fn::Base64 (no resolver of its own) still resolves its nested Fn::Sub correctly', () => {
    const result = resolveValue(consumerProp('Base64WrappingSubWithGetAtt'), context);

    // Fn::Base64 isn't a recognized key, so it falls through to the generic
    // object pass-through — but that pass-through still recurses, so the
    // Sub (with an implicit dotted-GetAtt placeholder) inside it resolves
    // exactly as it would standalone. This is what makes "arbitrary
    // composition" true even for not-yet-implemented outer functions, not
    // just implemented ones. (Fn::If, this test's original example, is now
    // genuinely resolved as of Ticket 1.5 — see conditions.test.ts.)
    expect(result).toEqual({
      kind: 'object',
      entries: [
        {
          key: 'Fn::Base64',
          value: {
            kind: 'list',
            items: [{ kind: 'scalar', value: 'arn-' }, { kind: 'attributeRef', logicalId: 'MyBucket', attribute: 'Arn' }],
          },
        },
      ],
    });
  });
});
