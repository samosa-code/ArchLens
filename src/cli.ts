#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { loadTemplate } from './parser/loader.js';
import { buildResolutionContext, findEntry, resolveValue } from './parser/intrinsics.js';
import { evaluateConditions, resourceInclusion } from './parser/conditions.js';
import type { ConditionValue, ResolvedValue, ResourceInclusion } from './common/types.js';

/**
 * Sprint 1's demo entry point: proves the parse → resolve → conditions
 * pipeline end to end from the command line, printing the resolved model
 * as JSON. Deliberately minimal — no argument-parsing library, no `--out`
 * flag, no HTML rendering (there's nothing to render yet). Sprint 3
 * (Ticket 3.4) builds the real `npx archlens <glob> --out <dir>` CLI on
 * top of this; this file is the seed, not a placeholder to be thrown away.
 */

const DEFAULT_DEMO_FILE = fileURLToPath(
  new URL('../examples/03-multi-stack-ecs-fargate/service-stack/template.yaml', import.meta.url),
);

/** One resource's slice of the printed model. */
interface DemoResource {
  /** The resource's `Type`, if it's a literal string (it always should be). */
  type: string | undefined;
  /** Whether this resource is actually created, per its `Condition` attribute (if any). */
  inclusion: ResourceInclusion;
  /** The resource's `Properties` block, fully resolved — `undefined` if it has none. */
  properties: ResolvedValue | undefined;
}

/** The whole printed model: one template's resources and evaluated conditions. */
interface DemoModel {
  file: string;
  conditions: Record<string, ConditionValue>;
  resources: Record<string, DemoResource>;
}

function buildDemoModel(filePath: string): DemoModel {
  const template = loadTemplate(filePath);

  const baseContext = buildResolutionContext(template);
  const conditionResults = evaluateConditions(template, baseContext);
  const context = { ...baseContext, conditions: conditionResults };

  const resources: Record<string, DemoResource> = {};
  const resourcesNode = findEntry(template, 'Resources');
  if (resourcesNode?.kind === 'object') {
    for (const { key, value: resourceNode } of resourcesNode.entries) {
      const typeNode = findEntry(resourceNode, 'Type');
      const propertiesNode = findEntry(resourceNode, 'Properties');
      resources[key] = {
        type: typeNode?.kind === 'scalar' && typeof typeNode.value === 'string' ? typeNode.value : undefined,
        inclusion: resourceInclusion(resourceNode, conditionResults),
        properties: propertiesNode ? resolveValue(propertiesNode, context) : undefined,
      };
    }
  }

  const conditions: Record<string, ConditionValue> = {};
  for (const [name, value] of conditionResults) {
    conditions[name] = value;
  }

  return { file: filePath, conditions, resources };
}

function main(): void {
  const filePath = process.argv[2] ?? DEFAULT_DEMO_FILE;

  let model: DemoModel;
  try {
    model = buildDemoModel(filePath);
  } catch (error) {
    console.error(`Failed to load ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify(model, null, 2));
}

main();
