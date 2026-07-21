import type { AstNode, ResolvedValue } from '../common/types.js';
import type { ResolutionContext } from '../common/interfaces.js';
import { splitGetAttShorthand } from './getAttShorthand.js';

/** Returns the entry value for `key` on an object-kind node, or `undefined` if absent/not an object. */
export function findEntry(node: AstNode, key: string): AstNode | undefined {
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

  return { parameters, resources, mappings, conditions: new Map() };
}

/** Resolves a `Ref` target name against Parameters, Resources, and AWS pseudo parameters. */
function resolveRef(name: string, context: ResolutionContext): ResolvedValue {
  if (name.startsWith('AWS::')) {
    const assumed = context.assumedPseudoParameters?.get(name);
    if (assumed !== undefined) {
      return { kind: 'scalar', value: assumed };
    }
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
 * Resolves a `logicalId`/`attribute` pair (already split, from whichever
 * `Fn::GetAtt` syntax produced them) to an `attributeRef`, or `unresolved`
 * if the resource isn't declared. Shared by {@link resolveGetAtt} and
 * `Fn::Sub`'s implicit-`GetAtt` handling (`${Resource.Attr}`), so both
 * agree on exactly what makes a `GetAtt` resolvable.
 */
function attributeRefOrUnresolved(logicalId: string, attribute: string, context: ResolutionContext): ResolvedValue {
  if (!context.resources.has(logicalId)) {
    return { kind: 'unresolved', reason: `Fn::GetAtt to undeclared resource "${logicalId}"` };
  }
  return { kind: 'attributeRef', logicalId, attribute };
}

/**
 * Resolves a `Fn::GetAtt` argument, which may be either the 2-element array
 * form (`[logicalId, attribute]`) or the dotted-string form
 * (`"logicalId.attribute"`, valid CFN long-form syntax independent of the
 * `!GetAtt` YAML tag shorthand `loader.ts` already normalizes).
 */
function resolveGetAtt(valueNode: AstNode, context: ResolutionContext): ResolvedValue {
  if (
    valueNode.kind === 'array' &&
    valueNode.items.length === 2 &&
    valueNode.items[0]!.kind === 'scalar' &&
    valueNode.items[1]!.kind === 'scalar'
  ) {
    return attributeRefOrUnresolved(String(valueNode.items[0]!.value), String(valueNode.items[1]!.value), context);
  }

  if (valueNode.kind === 'scalar') {
    const parts = splitGetAttShorthand(String(valueNode.value));
    if (parts.length < 2) {
      return { kind: 'unresolved', reason: `Fn::GetAtt malformed: "${String(valueNode.value)}" has no attribute` };
    }
    return attributeRefOrUnresolved(parts[0]!, parts[1]!, context);
  }

  return { kind: 'unresolved', reason: 'Fn::GetAtt has an unrecognized argument shape' };
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
 * Resolves `Fn::GetAZs`'s region argument (any shape — a literal string,
 * `AWS::Region`, or anything else) and wraps the result as an
 * `availabilityZonesRef`. Never guesses actual AZ names: which zones exist
 * and are enabled is deploy-time *and* account-specific, not something a
 * template alone can determine, the same reasoning `pseudoParameterRef`
 * already applies to other AWS-environment facts.
 */
function resolveGetAZs(argsNode: AstNode, context: ResolutionContext): ResolvedValue {
  return { kind: 'availabilityZonesRef', region: resolveValue(argsNode, context) };
}

/**
 * Resolves `Fn::Select`'s `[index, [items...]]` argument. Only the *index*
 * needs to be static — the selected item is returned however it resolves
 * (literal or reference), regardless of whether the list's other items are
 * themselves static.
 *
 * The list argument gets two special cases beyond a literal AST array:
 * - `!Select [N, !GetAZs region]` — an extremely common real-world idiom
 *   for pinning a resource to "the Nth Availability Zone" — resolves to a
 *   distinct `availabilityZoneRef` rather than falling through to
 *   `unresolved`, since the *position* is statically known even though the
 *   actual AZ name isn't.
 * - Any other intrinsic (most commonly `Fn::Split`, e.g. `!Select [0,
 *   !Split ["=", !Ref Tag]]`) that itself resolves to a `list` — selects
 *   directly from that resolved list, the same as it would from a literal
 *   AST array.
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
    const listResolved = resolveValue(listNode, context);
    if (listResolved.kind === 'availabilityZonesRef') {
      return { kind: 'availabilityZoneRef', region: listResolved.region, index };
    }
    if (listResolved.kind === 'list') {
      const selected = listResolved.items[index];
      if (selected === undefined) {
        return { kind: 'unresolved', reason: `Fn::Select index ${index} is out of bounds for a ${listResolved.items.length}-item list` };
      }
      return selected;
    }
    return { kind: 'unresolved', reason: 'Fn::Select list argument is not statically determinable' };
  }

  const selected = listNode.items[index];
  if (selected === undefined) {
    return { kind: 'unresolved', reason: `Fn::Select index ${index} is out of bounds for a ${listNode.items.length}-item list` };
  }

  return resolveValue(selected, context);
}

/** Matches a `${...}` placeholder in a `Fn::Sub` template string. */
const SUB_PLACEHOLDER = /\$\{([^}]*)\}/g;

/**
 * Resolves one `${...}` placeholder body (already trimmed, `!`-escape
 * already handled by the caller) against the explicit substitution map
 * (long-form `Fn::Sub`, if any) and, failing that, as an implicit `Ref` or
 * `Fn::GetAtt` — `${Name}` means `Ref: Name`, `${Resource.Attr}` means
 * `Fn::GetAtt: [Resource, Attr]`, per CFN's `Fn::Sub` semantics.
 */
function resolveSubVariable(name: string, substitutions: Map<string, AstNode> | undefined, context: ResolutionContext): ResolvedValue {
  const explicit = substitutions?.get(name);
  if (explicit !== undefined) {
    return resolveValue(explicit, context);
  }
  const dot = name.indexOf('.');
  if (dot !== -1) {
    return attributeRefOrUnresolved(name.slice(0, dot), name.slice(dot + 1), context);
  }
  return resolveRef(name, context);
}

/**
 * Resolves `Fn::Sub`'s template string, either the short form (a bare
 * string) or the long form (`[templateString, { Name: value, ... }]`).
 *
 * Splits the template into literal-text and resolved-placeholder segments.
 * If every segment ends up a literal scalar, collapses to one computed
 * string. Otherwise falls back to a `list` of the segments in order — same
 * "keep references visible rather than giving up" approach as
 * {@link resolveJoin} uses for its non-static parts.
 */
function resolveSub(argsNode: AstNode, context: ResolutionContext): ResolvedValue {
  let templateNode: AstNode;
  let substitutions: Map<string, AstNode> | undefined;

  if (argsNode.kind === 'scalar') {
    templateNode = argsNode;
  } else if (argsNode.kind === 'array' && argsNode.items.length === 2 && argsNode.items[1]!.kind === 'object') {
    templateNode = argsNode.items[0]!;
    substitutions = new Map(argsNode.items[1]!.entries.map(({ key, value }) => [key, value]));
  } else {
    return { kind: 'unresolved', reason: 'Fn::Sub arguments must be a string or [string, {substitutions}]' };
  }

  if (templateNode.kind !== 'scalar' || typeof templateNode.value !== 'string') {
    return { kind: 'unresolved', reason: 'Fn::Sub template must be a literal string' };
  }
  const template = templateNode.value;

  const segments: ResolvedValue[] = [];
  let lastIndex = 0;
  for (const match of template.matchAll(SUB_PLACEHOLDER)) {
    const literalBefore = template.slice(lastIndex, match.index);
    if (literalBefore.length > 0) {
      segments.push({ kind: 'scalar', value: literalBefore });
    }

    const body = match[1]!.trim();
    if (body.startsWith('!')) {
      segments.push({ kind: 'scalar', value: `\${${body.slice(1)}}` });
    } else {
      segments.push(resolveSubVariable(body, substitutions, context));
    }

    lastIndex = match.index + match[0].length;
  }

  const literalAfter = template.slice(lastIndex);
  if (literalAfter.length > 0 || segments.length === 0) {
    segments.push({ kind: 'scalar', value: literalAfter });
  }

  if (segments.every(isScalarResolved)) {
    return { kind: 'scalar', value: segments.map((segment) => scalarToJoinString(segment.value)).join('') };
  }
  return { kind: 'list', items: segments };
}

/** Resolves a node to a literal string, or `undefined` if it isn't statically one. */
function resolveToLiteralString(node: AstNode, context: ResolutionContext): string | undefined {
  const resolved = resolveValue(node, context);
  return resolved.kind === 'scalar' && typeof resolved.value === 'string' ? resolved.value : undefined;
}

/**
 * Resolves `Fn::Split`'s `[delimiter, sourceString]` arguments. Unlike
 * `Fn::GetAZs`, this is a pure string operation with no deploy-time-only
 * component — if both the delimiter and source string are literal, the
 * actual split is computed (mirroring `Fn::Join`'s collapse-when-static
 * behavior in reverse), rather than only ever tagging the call. Very
 * common paired with `Fn::Select` in real templates (`!Select [0, !Split
 * ["=", !Ref SomeTag]]`, parsing a `"key=value"`-formatted parameter).
 */
function resolveSplit(argsNode: AstNode, context: ResolutionContext): ResolvedValue {
  if (argsNode.kind !== 'array' || argsNode.items.length !== 2) {
    return { kind: 'unresolved', reason: 'Fn::Split arguments must be [delimiter, sourceString]' };
  }

  const delimiter = resolveToLiteralString(argsNode.items[0]!, context);
  if (delimiter === undefined) {
    return { kind: 'unresolved', reason: 'Fn::Split delimiter is not statically determinable' };
  }

  const source = resolveToLiteralString(argsNode.items[1]!, context);
  if (source === undefined) {
    return { kind: 'unresolved', reason: 'Fn::Split source string is not statically determinable' };
  }

  return { kind: 'list', items: source.split(delimiter).map((part) => ({ kind: 'scalar', value: part })) };
}

/**
 * Resolves `Fn::FindInMap`'s `[mapName, topLevelKey, secondLevelKey]`
 * arguments against {@link ResolutionContext.mappings}. All three arguments
 * must resolve to literal strings — `Mappings` lookups are keyed by exact
 * string match, so a dynamic key (e.g. `!Ref AWS::Region`, a very common
 * real-world pattern) can't be looked up statically and resolves to
 * `unresolved` rather than guessed.
 */
function resolveFindInMap(argsNode: AstNode, context: ResolutionContext): ResolvedValue {
  if (argsNode.kind !== 'array' || argsNode.items.length !== 3) {
    return { kind: 'unresolved', reason: 'Fn::FindInMap arguments must be [mapName, topLevelKey, secondLevelKey]' };
  }

  const mapName = resolveToLiteralString(argsNode.items[0]!, context);
  if (mapName === undefined) {
    return { kind: 'unresolved', reason: 'Fn::FindInMap map name is not statically determinable' };
  }

  const mapNode = context.mappings.get(mapName);
  if (mapNode === undefined || mapNode.kind !== 'object') {
    return { kind: 'unresolved', reason: `Fn::FindInMap references undeclared mapping "${mapName}"` };
  }

  const topLevelKey = resolveToLiteralString(argsNode.items[1]!, context);
  if (topLevelKey === undefined) {
    return { kind: 'unresolved', reason: 'Fn::FindInMap top-level key is not statically determinable' };
  }

  const topEntry = mapNode.entries.find((entry) => entry.key === topLevelKey);
  if (topEntry === undefined || topEntry.value.kind !== 'object') {
    return { kind: 'unresolved', reason: `Fn::FindInMap top-level key "${topLevelKey}" not found in mapping "${mapName}"` };
  }

  const secondLevelKey = resolveToLiteralString(argsNode.items[2]!, context);
  if (secondLevelKey === undefined) {
    return { kind: 'unresolved', reason: 'Fn::FindInMap second-level key is not statically determinable' };
  }

  const secondEntry = topEntry.value.entries.find((entry) => entry.key === secondLevelKey);
  if (secondEntry === undefined) {
    return {
      kind: 'unresolved',
      reason: `Fn::FindInMap second-level key "${secondLevelKey}" not found under "${topLevelKey}" in mapping "${mapName}"`,
    };
  }

  return resolveValue(secondEntry.value, context);
}

/**
 * Resolves `Fn::ImportValue`'s export-name argument and wraps it as an
 * `importValueRef` — tagged, not resolved. Actually matching it against
 * another template's `Export.Name` requires the multi-stack merge Sprint 2
 * builds; this ticket's job is only to resolve the export-name expression
 * itself as far as possible (e.g. collapse a `Fn::Join` to a literal
 * string) so Sprint 2 has a ready-to-match value instead of raw AST.
 */
function resolveImportValue(argsNode: AstNode, context: ResolutionContext): ResolvedValue {
  return { kind: 'importValueRef', exportName: resolveValue(argsNode, context) };
}

/**
 * Resolves `Fn::If`'s `[conditionName, valueIfTrue, valueIfFalse]`
 * arguments by looking up `conditionName` in `context.conditions` (see
 * `parser/conditions.ts`'s `evaluateConditions()` — `resolveValue()` itself
 * never evaluates a condition, only reads an already-evaluated one) and
 * resolving whichever branch it points to. If the condition isn't
 * statically true or false, resolves to `unresolved` rather than guessing
 * a branch — the same "never silently guessed" stance as `Ref`/`Fn::GetAtt`
 * apply to undefined names.
 */
function resolveIf(argsNode: AstNode, context: ResolutionContext): ResolvedValue {
  if (argsNode.kind !== 'array' || argsNode.items.length !== 3) {
    return { kind: 'unresolved', reason: 'Fn::If arguments must be [conditionName, valueIfTrue, valueIfFalse]' };
  }

  const conditionNameNode = argsNode.items[0]!;
  if (conditionNameNode.kind !== 'scalar' || typeof conditionNameNode.value !== 'string') {
    return { kind: 'unresolved', reason: 'Fn::If condition name must be a literal string' };
  }

  const conditionResult = context.conditions.get(conditionNameNode.value);
  if (conditionResult === undefined) {
    return { kind: 'unresolved', reason: `Fn::If references undefined condition "${conditionNameNode.value}"` };
  }
  if (conditionResult.kind === 'true') {
    return resolveValue(argsNode.items[1]!, context);
  }
  if (conditionResult.kind === 'false') {
    return resolveValue(argsNode.items[2]!, context);
  }
  return { kind: 'unresolved', reason: `Fn::If condition "${conditionNameNode.value}" is not statically determinable` };
}

/**
 * Resolves a single property value node against a {@link ResolutionContext},
 * substituting `Ref`, `Fn::GetAtt`, `Fn::Join`, `Fn::Select`, `Fn::Sub`,
 * `Fn::FindInMap`, `Fn::ImportValue`, `Fn::GetAZs`, `Fn::Split`, and
 * `Fn::If` calls with their resolved value where statically determinable.
 * `Fn::If` reads `context.conditions` rather than evaluating anything
 * itself — see `parser/conditions.ts`.
 * `Fn::GetStackOutput` is recognized but deliberately reported `unresolved`
 * (its cross-account/cross-Region resolution is out of scope — see PO
 * Question 4e in SPRINT-PLAN.md), rather than falling through silently like
 * other genuinely-unimplemented intrinsics (e.g. `Fn::Base64`), since it
 * represents a real cross-stack reference that would otherwise be lost.
 * Anything else (plain scalars/arrays/objects, or an intrinsic not yet
 * implemented) passes through structurally unchanged, recursing into any
 * nested intrinsics it contains.
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
    if (key === 'Fn::Sub') {
      return resolveSub(value, context);
    }
    if (key === 'Fn::FindInMap') {
      return resolveFindInMap(value, context);
    }
    if (key === 'Fn::ImportValue') {
      return resolveImportValue(value, context);
    }
    if (key === 'Fn::GetStackOutput') {
      return { kind: 'unresolved', reason: 'Fn::GetStackOutput is not yet supported' };
    }
    if (key === 'Fn::GetAZs') {
      return resolveGetAZs(value, context);
    }
    if (key === 'Fn::Split') {
      return resolveSplit(value, context);
    }
    if (key === 'Fn::If') {
      return resolveIf(value, context);
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
