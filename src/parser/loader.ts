import { readFileSync } from 'node:fs';
import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import type { Node as YamlNode } from 'yaml';
import { parseTree, printParseErrorCode } from 'jsonc-parser';
import type { Node as JsonNode, ParseError } from 'jsonc-parser';
import type { AstEntry, SourcePosition } from '../common/interfaces.js';
import type { AstNode } from '../common/types.js';

/**
 * Converts a character offset into a source string to a 1-indexed
 * {@link SourcePosition} by counting newlines up to that offset.
 *
 * Both the YAML and JSON code paths funnel through this single function so
 * that positions from either format use identical semantics (1-indexed,
 * computed the same way) rather than trusting each underlying library's own
 * line/column convention.
 */
function offsetToPosition(source: string, offset: number, file: string): SourcePosition {
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < offset; i++) {
    if (source[i] === '\n') {
      line++;
      lastNewline = i;
    }
  }
  return { file, line, column: offset - lastNewline };
}

/**
 * CloudFormation's short-form YAML intrinsic tags, mapped to the long-form
 * key JSON templates always use for the same intrinsic (e.g. YAML's
 * `!Ref Foo` and JSON's `{"Ref": "Foo"}` must parse to the same AST shape).
 * `!GetAtt` is handled separately below since its shorthand also changes
 * shape (dotted string → array), not just its key name.
 */
const SHORT_FORM_TAGS: Record<string, string> = {
  '!Ref': 'Ref',
  '!Condition': 'Condition',
  '!GetAtt': 'Fn::GetAtt',
  '!Sub': 'Fn::Sub',
  '!Join': 'Fn::Join',
  '!Select': 'Fn::Select',
  '!Split': 'Fn::Split',
  '!FindInMap': 'Fn::FindInMap',
  '!Base64': 'Fn::Base64',
  '!Cidr': 'Fn::Cidr',
  '!ImportValue': 'Fn::ImportValue',
  '!GetAZs': 'Fn::GetAZs',
  '!If': 'Fn::If',
  '!Not': 'Fn::Not',
  '!Equals': 'Fn::Equals',
  '!And': 'Fn::And',
  '!Or': 'Fn::Or',
  '!Transform': 'Fn::Transform',
};

/** Reads the raw YAML tag (e.g. `"!Ref"`) off a node, if it has one. */
function getTag(node: YamlNode): string | undefined {
  return (node as { tag?: string }).tag;
}

/**
 * Wraps a tagged node's converted content in `{ [longFormKey]: content }`,
 * matching the AST shape JSON's long-form intrinsic syntax already produces.
 *
 * `!GetAtt`'s shorthand is a single dotted string (`Resource.Attr`); only
 * the first dot splits resource from attribute, since the attribute name
 * itself may contain dots (e.g. a nested stack output).
 */
function wrapShortFormTag(longKey: string, node: YamlNode, source: string, file: string): AstNode {
  const pos = offsetToPosition(source, node.range?.[0] ?? 0, file);

  let value: AstNode;
  if (longKey === 'Fn::GetAtt' && isScalar(node)) {
    const raw = String(node.value);
    const dot = raw.indexOf('.');
    const parts = dot === -1 ? [raw] : [raw.slice(0, dot), raw.slice(dot + 1)];
    value = { kind: 'array', items: parts.map((part) => ({ kind: 'scalar', value: part, pos })), pos };
  } else {
    value = convertNode(node, source, file);
  }

  return { kind: 'object', entries: [{ key: longKey, keyPos: pos, value }], pos };
}

/**
 * Converts a `yaml` package node to our normalized {@link AstNode}, first
 * checking for a CloudFormation short-form intrinsic tag (`!Ref`, `!GetAtt`,
 * etc.) and normalizing it to the same long-form shape JSON templates use,
 * so downstream code never has to care which source format a template was
 * written in.
 */
function yamlToAst(node: YamlNode, source: string, file: string): AstNode {
  const tag = getTag(node);
  const longKey = tag !== undefined ? SHORT_FORM_TAGS[tag] : undefined;
  if (longKey !== undefined) {
    return wrapShortFormTag(longKey, node, source, file);
  }
  return convertNode(node, source, file);
}

/**
 * Structural (tag-agnostic) conversion of a `yaml` package node into our
 * normalized {@link AstNode} tree, resolving every node's character offset
 * to a {@link SourcePosition} along the way. Nested values are converted via
 * {@link yamlToAst} so their own tags (if any) are still normalized.
 */
function convertNode(node: YamlNode, source: string, file: string): AstNode {
  const start = node.range?.[0] ?? 0;
  const pos = offsetToPosition(source, start, file);

  if (isMap(node)) {
    const entries: AstEntry[] = node.items.map((pair) => {
      const keyNode = pair.key as YamlNode;
      const keyStart = keyNode.range?.[0] ?? 0;
      return {
        key: String(isScalar(keyNode) ? keyNode.value : keyNode),
        keyPos: offsetToPosition(source, keyStart, file),
        value: yamlToAst(pair.value as YamlNode, source, file),
      };
    });
    return { kind: 'object', entries, pos };
  }

  if (isSeq(node)) {
    const items = node.items.map((item) => yamlToAst(item as YamlNode, source, file));
    return { kind: 'array', items, pos };
  }

  if (isScalar(node)) {
    return { kind: 'scalar', value: node.value as string | number | boolean | null, pos };
  }

  throw new Error(`Unsupported YAML node (anchors/aliases not yet supported) at ${file}:${pos.line}:${pos.column}`);
}

/**
 * Parses a YAML template into our normalized {@link AstNode} tree.
 * Throws if the `yaml` package reports any parse errors, rather than
 * silently returning a partial tree.
 */
function loadYaml(source: string, file: string): AstNode {
  const doc = parseDocument(source);
  if (doc.errors.length > 0) {
    const messages = doc.errors.map((error) => error.message).join('; ');
    throw new Error(`Failed to parse YAML template ${file}: ${messages}`);
  }
  return yamlToAst(doc.contents as YamlNode, source, file);
}

/**
 * Recursively converts a `jsonc-parser` tree node into our normalized
 * {@link AstNode} tree, resolving every node's character offset to a
 * {@link SourcePosition} along the way.
 */
function jsonToAst(node: JsonNode, source: string, file: string): AstNode {
  const pos = offsetToPosition(source, node.offset, file);

  if (node.type === 'object') {
    const entries: AstEntry[] = (node.children ?? []).map((property) => {
      const [keyNode, valueNode] = property.children as [JsonNode, JsonNode];
      return {
        key: String(keyNode.value),
        keyPos: offsetToPosition(source, keyNode.offset, file),
        value: jsonToAst(valueNode, source, file),
      };
    });
    return { kind: 'object', entries, pos };
  }

  if (node.type === 'array') {
    const items = (node.children ?? []).map((child) => jsonToAst(child, source, file));
    return { kind: 'array', items, pos };
  }

  return { kind: 'scalar', value: (node.value ?? null) as string | number | boolean | null, pos };
}

/**
 * Parses a CloudFormation JSON template into our normalized {@link AstNode}
 * tree. Deliberately strict — CloudFormation's JSON format does not permit
 * comments or trailing commas, so both are rejected here rather than
 * leniently accepted the way a general-purpose JSONC parser would by
 * default.
 */
function loadJson(source: string, file: string): AstNode {
  const errors: ParseError[] = [];
  const tree = parseTree(source, errors, { allowTrailingComma: false, disallowComments: true });

  if (errors.length > 0 || !tree) {
    const messages = errors.map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`).join('; ');
    throw new Error(`Failed to parse JSON template ${file}: ${messages}`);
  }

  return jsonToAst(tree, source, file);
}

/**
 * Loads a CloudFormation template (YAML or JSON, chosen by file extension)
 * from disk and parses it into a normalized {@link AstNode} tree, with every
 * node carrying its {@link SourcePosition} for later click-to-source
 * navigation.
 *
 * Throws on malformed input (invalid YAML syntax, invalid/non-strict JSON)
 * rather than attempting recovery — graceful multi-file degradation
 * (skip-and-warn) is a pipeline-level concern handled by the caller, not
 * this function.
 */
export function loadTemplate(filePath: string): AstNode {
  const source = readFileSync(filePath, 'utf8');
  return filePath.endsWith('.json') ? loadJson(source, filePath) : loadYaml(source, filePath);
}
