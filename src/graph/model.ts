import type { AstNode, GraphEdge, GraphNodeId, GraphWarning, ResolvedValue } from '../common/types.js';
import type { GraphModel, GraphNode } from '../common/interfaces.js';
import { buildResolutionContext, findEntry, resolveValue } from '../parser/intrinsics.js';
import { evaluateConditions, resourceInclusion } from '../parser/conditions.js';
import { walkResolvedValueLeaves } from './resolvedValueWalk.js';

/**
 * A {@link GraphNode}'s identity. Per PO Question 4d, always the origin
 * file combined with the logical ID — two unrelated templates that happen
 * to declare a same-named resource must never collapse into one node.
 */
export function nodeId(file: string, logicalId: string): GraphNodeId {
  return `${file}#${logicalId}`;
}

/**
 * Walks a resolved `Properties` value tree (via the shared
 * {@link walkResolvedValueLeaves}) looking for `resourceRef`/`attributeRef`
 * leaves, emitting one `reference` edge per occurrence — never collapsed,
 * so the same target referenced twice produces two edges.
 *
 * Deliberately does NOT recurse into `importValueRef`: its `exportName` may
 * itself contain a `resourceRef` (e.g. `!ImportValue { Fn::Join: [":",
 * [!Ref Foo, "suffix"]] }`), but that `Ref` is used to compute a cross-stack
 * *lookup key*, not a same-template architectural dependency — walking into
 * it would produce a false-positive edge to a resource this property never
 * actually consumes. `walkResolvedValueLeaves` treats every non-list/object
 * kind (including `importValueRef`) as an opaque leaf, so this falls out
 * automatically rather than needing its own exclusion check here.
 */
function extractReferenceEdges(properties: ResolvedValue, source: GraphNodeId, file: string): GraphEdge[] {
  const edges: GraphEdge[] = [];
  walkResolvedValueLeaves(properties, [], (path, leaf) => {
    if (leaf.kind === 'resourceRef') {
      edges.push({ kind: 'reference', source, target: nodeId(file, leaf.logicalId), propertyPath: path, via: { kind: 'ref' } });
    } else if (leaf.kind === 'attributeRef') {
      edges.push({
        kind: 'reference',
        source,
        target: nodeId(file, leaf.logicalId),
        propertyPath: path,
        via: { kind: 'getAtt', attribute: leaf.attribute },
      });
    }
  });
  return edges;
}

/**
 * Extracts `dependsOn` edges from a resource's `DependsOn` attribute, which
 * (unlike `Properties`) bypasses `resolveValue()` entirely — it's always a
 * bare logical-ID string or list of strings, never an intrinsic — so its
 * targets need their own existence check here, pushing a {@link GraphWarning}
 * for anything that isn't a declared resource rather than silently dropping
 * it or fabricating an edge to a nonexistent node.
 */
function extractDependsOnEdges(
  resourceNode: AstNode,
  logicalId: string,
  file: string,
  resources: Set<string>,
  warnings: GraphWarning[],
): GraphEdge[] {
  const dependsOnNode = findEntry(resourceNode, 'DependsOn');
  if (dependsOnNode === undefined) return [];

  const targets: string[] = [];
  if (dependsOnNode.kind === 'scalar' && typeof dependsOnNode.value === 'string') {
    targets.push(dependsOnNode.value);
  } else if (dependsOnNode.kind === 'array') {
    for (const item of dependsOnNode.items) {
      if (item.kind === 'scalar' && typeof item.value === 'string') {
        targets.push(item.value);
      } else {
        warnings.push({ kind: 'dependsOnTargetInvalid', file, logicalId, message: 'DependsOn entry is not a literal string' });
      }
    }
  } else {
    warnings.push({ kind: 'dependsOnTargetInvalid', file, logicalId, message: 'DependsOn attribute is not a string or array of strings' });
    return [];
  }

  const source = nodeId(file, logicalId);
  const edges: GraphEdge[] = [];
  for (const target of targets) {
    if (!resources.has(target)) {
      warnings.push({ kind: 'dependsOnTargetInvalid', file, logicalId, message: `DependsOn references undeclared resource "${target}"` });
      continue;
    }
    edges.push({ kind: 'dependsOn', source, target: nodeId(file, target) });
  }
  return edges;
}

/**
 * Builds a {@link GraphModel} from one already-parsed template (Ticket 2.1 —
 * single-template construction; merging N templates' graphs into one,
 * including `crossStackImport` edges, is Ticket 2.2/2.3's job).
 *
 * Every declared `Resources` entry becomes a node, regardless of its
 * `Condition` outcome (PO Question 1 — `excluded`/`unknown` resources are
 * never omitted, only flagged). `reference` edges come from walking each
 * resource's resolved `Properties`; `dependsOn` edges come from its
 * `DependsOn` attribute, validated separately since it bypasses
 * `resolveValue()`. `Metadata` is never walked for edges — its intrinsic
 * usage in real templates was confirmed (during Ticket 2.1 fixture research)
 * to be non-referential (e.g. `cfn-lint`/`guard` suppression annotations).
 */
export function buildGraph(file: string, template: AstNode): GraphModel {
  const baseContext = buildResolutionContext(template);
  const conditionResults = evaluateConditions(template, baseContext);
  const context = { ...baseContext, conditions: conditionResults };

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const warnings: GraphWarning[] = [];

  const resourcesNode = findEntry(template, 'Resources');
  if (resourcesNode?.kind === 'object') {
    for (const { key: logicalId, value: resourceNode } of resourcesNode.entries) {
      const source = nodeId(file, logicalId);
      const typeNode = findEntry(resourceNode, 'Type');
      const propertiesNode = findEntry(resourceNode, 'Properties');
      const properties = propertiesNode ? resolveValue(propertiesNode, context) : undefined;

      nodes.push({
        id: source,
        logicalId,
        type: typeNode?.kind === 'scalar' && typeof typeNode.value === 'string' ? typeNode.value : undefined,
        file,
        pos: resourceNode.kind === 'object' ? resourceNode.pos : { file, line: 0, column: 0 },
        properties,
        inclusion: resourceInclusion(resourceNode, conditionResults),
      });

      if (properties !== undefined) {
        edges.push(...extractReferenceEdges(properties, source, file));
      }
      edges.push(...extractDependsOnEdges(resourceNode, logicalId, file, context.resources, warnings));
    }
  }

  return { nodes, edges, warnings };
}
