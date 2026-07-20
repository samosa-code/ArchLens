import type { AstNode, ConditionValue, ResolvedValue, ResourceInclusion } from '../common/types.js';
import type { ResolutionContext } from '../common/interfaces.js';
import { findEntry, resolveValue } from './intrinsics.js';

/** Compares two resolved values for `Fn::Equals`; `undefined` if either isn't a literal. */
function scalarsEqual(a: ResolvedValue, b: ResolvedValue): boolean | undefined {
  if (a.kind !== 'scalar' || b.kind !== 'scalar') return undefined;
  return String(a.value) === String(b.value);
}

/**
 * Evaluates one condition-expression AstNode (the value side of a
 * `Conditions` block entry, or an operand of `Fn::And`/`Fn::Or`/`Fn::Not`)
 * to a three-valued {@link ConditionValue}.
 *
 * `definitions`/`cache`/`inProgress` thread through recursive `Condition`
 * references (`{Condition: "OtherName"}`, CFN's way of referencing another
 * named condition from inside `Fn::And`/`Fn::Or`/`Fn::Not`) so repeated
 * references are only evaluated once and circular references resolve to
 * `unknown` instead of infinite-looping.
 */
function evaluateExpression(
  node: AstNode,
  definitions: Map<string, AstNode>,
  context: ResolutionContext,
  cache: Map<string, ConditionValue>,
  inProgress: Set<string>,
): ConditionValue {
  if (node.kind !== 'object' || node.entries.length !== 1) {
    return { kind: 'unknown', reason: 'condition expression has an unrecognized shape' };
  }
  const { key, value } = node.entries[0]!;

  if (key === 'Condition') {
    const name = value.kind === 'scalar' ? String(value.value) : '';
    return evaluateNamed(name, definitions, context, cache, inProgress);
  }

  if (key === 'Fn::Equals') {
    if (value.kind !== 'array' || value.items.length !== 2) {
      return { kind: 'unknown', reason: 'Fn::Equals arguments must be [value1, value2]' };
    }
    const left = resolveValue(value.items[0]!, context);
    const right = resolveValue(value.items[1]!, context);
    const equal = scalarsEqual(left, right);
    if (equal === undefined) {
      return { kind: 'unknown', reason: 'Fn::Equals operand is not statically determinable' };
    }
    return equal ? { kind: 'true' } : { kind: 'false' };
  }

  if (key === 'Fn::Not') {
    if (value.kind !== 'array' || value.items.length !== 1) {
      return { kind: 'unknown', reason: 'Fn::Not arguments must be [condition]' };
    }
    const inner = evaluateExpression(value.items[0]!, definitions, context, cache, inProgress);
    if (inner.kind === 'true') return { kind: 'false' };
    if (inner.kind === 'false') return { kind: 'true' };
    return inner;
  }

  if (key === 'Fn::And') {
    if (value.kind !== 'array' || value.items.length === 0) {
      return { kind: 'unknown', reason: 'Fn::And arguments must be a non-empty list of conditions' };
    }
    const operands = value.items.map((item) => evaluateExpression(item, definitions, context, cache, inProgress));
    // Short-circuit: any operand definitively false makes the whole AND
    // false, regardless of whether other operands are unknown.
    if (operands.some((operand) => operand.kind === 'false')) return { kind: 'false' };
    if (operands.some((operand) => operand.kind === 'unknown')) {
      return { kind: 'unknown', reason: 'Fn::And has an operand that is not statically determinable' };
    }
    return { kind: 'true' };
  }

  if (key === 'Fn::Or') {
    if (value.kind !== 'array' || value.items.length === 0) {
      return { kind: 'unknown', reason: 'Fn::Or arguments must be a non-empty list of conditions' };
    }
    const operands = value.items.map((item) => evaluateExpression(item, definitions, context, cache, inProgress));
    // Short-circuit: any operand definitively true makes the whole OR true,
    // regardless of whether other operands are unknown.
    if (operands.some((operand) => operand.kind === 'true')) return { kind: 'true' };
    if (operands.some((operand) => operand.kind === 'unknown')) {
      return { kind: 'unknown', reason: 'Fn::Or has an operand that is not statically determinable' };
    }
    return { kind: 'false' };
  }

  return { kind: 'unknown', reason: `unrecognized condition function "${key}"` };
}

/** Evaluates a named `Conditions` block entry, memoizing results and detecting circular references. */
function evaluateNamed(
  name: string,
  definitions: Map<string, AstNode>,
  context: ResolutionContext,
  cache: Map<string, ConditionValue>,
  inProgress: Set<string>,
): ConditionValue {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  if (inProgress.has(name)) {
    const result: ConditionValue = { kind: 'unknown', reason: `circular reference in condition "${name}"` };
    cache.set(name, result);
    return result;
  }

  const definition = definitions.get(name);
  if (definition === undefined) {
    const result: ConditionValue = { kind: 'unknown', reason: `references undefined condition "${name}"` };
    cache.set(name, result);
    return result;
  }

  inProgress.add(name);
  const result = evaluateExpression(definition, definitions, context, cache, inProgress);
  inProgress.delete(name);
  cache.set(name, result);
  return result;
}

/**
 * Evaluates every entry in a template's `Conditions` block to a
 * {@link ConditionValue}, resolving `Fn::Equals` operands (and anything
 * nested inside them) via `intrinsics.ts`'s `resolveValue`.
 */
export function evaluateConditions(template: AstNode, context: ResolutionContext): Map<string, ConditionValue> {
  const definitions = new Map<string, AstNode>();
  const conditionsNode = findEntry(template, 'Conditions');
  if (conditionsNode?.kind === 'object') {
    for (const { key, value } of conditionsNode.entries) {
      definitions.set(key, value);
    }
  }

  const cache = new Map<string, ConditionValue>();
  const inProgress = new Set<string>();
  for (const name of definitions.keys()) {
    evaluateNamed(name, definitions, context, cache, inProgress);
  }
  return cache;
}

/**
 * Determines whether a resource is included, excluded, or ambiguous, given
 * its (optional) `Condition` attribute and the evaluated `Conditions`
 * block. A resource with no `Condition` attribute is always `included`.
 */
export function resourceInclusion(resourceNode: AstNode, conditionResults: Map<string, ConditionValue>): ResourceInclusion {
  const conditionNode = findEntry(resourceNode, 'Condition');
  if (conditionNode === undefined) {
    return { kind: 'included' };
  }
  if (conditionNode.kind !== 'scalar' || typeof conditionNode.value !== 'string') {
    return { kind: 'unknown', reason: 'resource Condition attribute is not a literal condition name' };
  }

  const result = conditionResults.get(conditionNode.value);
  if (result === undefined) {
    return { kind: 'unknown', reason: `resource references undefined condition "${conditionNode.value}"` };
  }
  if (result.kind === 'true') return { kind: 'included' };
  if (result.kind === 'false') return { kind: 'excluded' };
  return { kind: 'unknown', reason: result.reason };
}
