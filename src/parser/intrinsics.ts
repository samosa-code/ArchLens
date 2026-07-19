import type { AstNode, ResolvedValue } from '../common/types.js';
import type { ResolutionContext } from '../common/interfaces.js';
import { splitGetAttShorthand } from './getAttShorthand.js';

/** Returns the entry value for `key` on an object-kind node, or `undefined` if absent/not an object. */
function findEntry(node: AstNode, key: string): AstNode | undefined {
  if (node.kind !== 'object') return undefined;
  return node.entries.find((entry) => entry.key === key)?.value;
}

/** Builds a {@link ResolutionContext} from a whole parsed template's AST. */
export function buildResolutionContext(template: AstNode): ResolutionContext {
  const parameters = new Map<string, AstNode | undefined>();
  const parametersNode = findEntry(template, 'Parameters');
  if (parametersNode?.kind === 'object') {
    for (const { key, value } of parametersNode.entries) {
      parameters.set(key, findEntry(value, 'Default'));
    }
  }

  const resources = new Set<string>();
  const resourcesNode = findEntry(template, 'Resources');
  if (resourcesNode?.kind === 'object') {
    for (const { key } of resourcesNode.entries) {
      resources.add(key);
    }
  }

  const mappings = new Map<string, AstNode>();
  const mappingsNode = findEntry(template, 'Mappings');
  if (mappingsNode?.kind === 'object') {
    for (const { key, value } of mappingsNode.entries) {
      mappings.set(key, value);
    }
  }

  return { parameters, resources, mappings };
}

/** Resolves a `Ref` target name against Parameters, Resources, and AWS pseudo parameters. */
function resolveRef(name: string, context: ResolutionContext): ResolvedValue {
  if (name.startsWith('AWS::')) {
    return { kind: 'pseudoParameterRef', name };
  }
  if (context.parameters.has(name)) {
    const defaultValue = context.parameters.get(name);
    return defaultValue !== undefined ? resolveValue(defaultValue, context) : { kind: 'parameterRef', name };
  }
  if (context.resources.has(name)) {
    return { kind: 'resourceRef', logicalId: name };
  }
  return { kind: 'unresolved', reason: `Ref to undefined name "${name}"` };
}

/**
 * Resolves a `Fn::GetAtt` argument, which may be either the 2-element array
 * form (`[logicalId, attribute]`) or the dotted-string form
 * (`"logicalId.attribute"`, valid CFN long-form syntax independent of the
 * `!GetAtt` YAML tag shorthand `loader.ts` already normalizes).
 */
function resolveGetAtt(valueNode: AstNode, context: ResolutionContext): ResolvedValue {
  let logicalId: string;
  let attribute: string;

  if (
    valueNode.kind === 'array' &&
    valueNode.items.length === 2 &&
    valueNode.items[0]!.kind === 'scalar' &&
    valueNode.items[1]!.kind === 'scalar'
  ) {
    logicalId = String(valueNode.items[0]!.value);
    attribute = String(valueNode.items[1]!.value);
  } else if (valueNode.kind === 'scalar') {
    const parts = splitGetAttShorthand(String(valueNode.value));
    if (parts.length < 2) {
      return { kind: 'unresolved', reason: `Fn::GetAtt malformed: "${String(valueNode.value)}" has no attribute` };
    }
    [logicalId, attribute] = parts as [string, string];
  } else {
    return { kind: 'unresolved', reason: 'Fn::GetAtt has an unrecognized argument shape' };
  }

  if (!context.resources.has(logicalId)) {
    return { kind: 'unresolved', reason: `Fn::GetAtt to undeclared resource "${logicalId}"` };
  }

  return { kind: 'attributeRef', logicalId, attribute };
}

/** Narrows a {@link ResolvedValue} to its scalar variant. */
function isScalarResolved(value: ResolvedValue): value is Extract<ResolvedValue, { kind: 'scalar' }> {
  return value.kind === 'scalar';
}

/** Coerces a resolved scalar's value to the string CFN's Fn::Join would produce. */
function scalarToJoinString(value: string | number | boolean | null): string {
  return value === null ? '' : String(value);
}

/**
 * Resolves `Fn::Join`'s `[delimiter, [parts...]]` argument. If the delimiter
 * and every part resolve to a literal scalar, computes the actual joined
 * string. Otherwise falls back to returning the resolved parts as a list —
 * not collapsed into a string, but any reference (`Ref`/`Fn::GetAtt`) nested
 * among the parts stays visible for the graph model to pick up, rather than
 * being lost inside an opaque "unresolved" result.
 */
function resolveJoin(argsNode: AstNode, context: ResolutionContext): ResolvedValue {
  if (argsNode.kind !== 'array' || argsNode.items.length !== 2) {
    return { kind: 'unresolved', reason: 'Fn::Join arguments must be [delimiter, [parts...]]' };
  }

  const delimiterResolved = resolveValue(argsNode.items[0]!, context);
  if (delimiterResolved.kind !== 'scalar' || typeof delimiterResolved.value !== 'string') {
    return { kind: 'unresolved', reason: 'Fn::Join delimiter is not statically determinable' };
  }

  const partsNode = argsNode.items[1]!;
  if (partsNode.kind !== 'array') {
    return { kind: 'unresolved', reason: 'Fn::Join parts argument is not statically determinable' };
  }

  const resolvedParts = partsNode.items.map((item) => resolveValue(item, context));
  if (resolvedParts.every(isScalarResolved)) {
    const joined = resolvedParts.map((part) => scalarToJoinString(part.value)).join(delimiterResolved.value);
    return { kind: 'scalar', value: joined };
  }

  return { kind: 'list', items: resolvedParts };
}

/**
 * Resolves `Fn::Select`'s `[index, [items...]]` argument. Only the *index*
 * needs to be static — the selected item is returned however it resolves
 * (literal or reference), regardless of whether the list's other items are
 * themselves static.
 */
function resolveSelect(argsNode: AstNode, context: ResolutionContext): ResolvedValue {
  if (argsNode.kind !== 'array' || argsNode.items.length !== 2) {
    return { kind: 'unresolved', reason: 'Fn::Select arguments must be [index, [items...]]' };
  }

  const indexResolved = resolveValue(argsNode.items[0]!, context);
  const index =
    indexResolved.kind === 'scalar' && (typeof indexResolved.value === 'number' || typeof indexResolved.value === 'string')
      ? Number(indexResolved.value)
      : NaN;
  if (!Number.isInteger(index)) {
    return { kind: 'unresolved', reason: 'Fn::Select index is not statically determinable' };
  }

  const listNode = argsNode.items[1]!;
  if (listNode.kind !== 'array') {
    return { kind: 'unresolved', reason: 'Fn::Select list argument is not statically determinable' };
  }

  const selected = listNode.items[index];
  if (selected === undefined) {
    return { kind: 'unresolved', reason: `Fn::Select index ${index} is out of bounds for a ${listNode.items.length}-item list` };
  }

  return resolveValue(selected, context);
}

/**
 * Resolves a single property value node against a {@link ResolutionContext},
 * substituting `Ref`, `Fn::GetAtt`, `Fn::Join`, and `Fn::Select` calls with
 * their resolved value where statically determinable.
 */
export function resolveValue(node: AstNode, context: ResolutionContext): ResolvedValue {
  if (node.kind === 'object' && node.entries.length === 1) {
    const { key, value } = node.entries[0]!;
    if (key === 'Ref') {
      const name = value.kind === 'scalar' ? String(value.value) : '';
      return resolveRef(name, context);
    }
    if (key === 'Fn::GetAtt') {
      return resolveGetAtt(value, context);
    }
    if (key === 'Fn::Join') {
      return resolveJoin(value, context);
    }
    if (key === 'Fn::Select') {
      return resolveSelect(value, context);
    }
  }

  if (node.kind === 'scalar') {
    return { kind: 'scalar', value: node.value };
  }

  if (node.kind === 'array') {
    return { kind: 'list', items: node.items.map((item) => resolveValue(item, context)) };
  }

  return { kind: 'object', entries: node.entries.map(({ key, value }) => ({ key, value: resolveValue(value, context) })) };
}
