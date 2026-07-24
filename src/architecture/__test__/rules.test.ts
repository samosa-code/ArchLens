import { describe, expect, test } from 'vitest';
import { loadTemplates } from '../../parser/loader.js';
import { mergeGraphs } from '../../graph/merge.js';
import { LAYER_ORDER, PLUMBING_SUFFIXES, RULES } from '../rules.js';
import { allExampleFiles } from './corpusHelpers.js';
import type { ConnectorSpec, TypeRule } from '../types.js';

/**
 * Ticket A.2's rule-table validation: the table is data, so these tests are
 * the table's compiler — every structural promise the six-pass pipeline
 * (A.3–A.9) relies on is asserted here, against the table itself, so a bad
 * row fails fast at test time instead of misclassifying quietly at runtime.
 */

const ruleEntries = Object.entries(RULES);

function connectorSpecs(rule: TypeRule): ConnectorSpec[] {
  if (rule.connector === undefined) return [];
  return Array.isArray(rule.connector) ? rule.connector : [rule.connector];
}

describe('rule table internal consistency (no fixtures)', () => {
  test('table is non-trivially populated (~120 types is v1 scale; a mass deletion is a regression, not a cleanup)', () => {
    expect(ruleEntries.length).toBeGreaterThanOrEqual(100);
  });

  test('every rule has exactly one role and only that role\'s fields', () => {
    for (const [type, rule] of ruleEntries) {
      expect(['component', 'container', 'detail', 'connector'], `${type}: unknown role`).toContain(rule.role);

      if (rule.role === 'component' || rule.role === 'container') {
        expect(rule.layer, `${type}: ${rule.role} needs a layer`).toBeDefined();
        expect(rule.service, `${type}: ${rule.role} needs a service`).toBeDefined();
        expect(rule.absorbInto, `${type}: ${rule.role} must not declare absorbInto`).toBeUndefined();
        expect(rule.connector, `${type}: ${rule.role} must not declare a connector spec`).toBeUndefined();
        expect(rule.group, `${type}: ${rule.role} must not declare a panel group`).toBeUndefined();
      }

      if (rule.role === 'container') {
        expect(rule.containerKind, `${type}: container needs a containerKind (which boundary kind Pass 2 builds)`).toBeDefined();
      } else {
        expect(rule.containerKind, `${type}: only containers declare containerKind`).toBeUndefined();
      }

      if (rule.role === 'detail') {
        expect(rule.group, `${type}: detail needs a panel group`).toBeDefined();
        const hasOwnerStrategy = (rule.absorbInto !== undefined && rule.absorbInto.length > 0) || rule.ownerByNamePattern !== undefined;
        expect(hasOwnerStrategy, `${type}: detail needs absorbInto candidates and/or ownerByNamePattern`).toBe(true);
        expect(rule.connector, `${type}: detail must not declare a connector spec`).toBeUndefined();
        expect(rule.layer, `${type}: detail must not declare a layer`).toBeUndefined();
      }

      if (rule.role === 'connector') {
        expect(connectorSpecs(rule).length, `${type}: connector needs at least one spec`).toBeGreaterThan(0);
        expect(rule.group, `${type}: connector needs a panel group (it degrades to an absorbed detail when its endpoints don't resolve)`).toBeDefined();
        expect(rule.absorbInto !== undefined && rule.absorbInto.length > 0, `${type}: connector needs absorbInto (its degraded-detail owner)`).toBe(true);
        expect(rule.layer, `${type}: connector must not declare a layer`).toBeUndefined();
      }
    }
  });

  test('every absorbInto target is itself rule-declared', () => {
    // A detail-role OR connector-role target is a legal intermediate hop:
    // Ticket A.5's resolver chases any absorbable transitively to its own
    // surviving owner (ListenerRule → Listener → LoadBalancer). What the
    // chain-termination test below guarantees is that every such chain
    // *ends* at a component/container — the final owner is never
    // something that vanishes.
    for (const [type, rule] of ruleEntries) {
      for (const target of rule.absorbInto ?? []) {
        expect(RULES[target], `${type}: absorbInto target ${target} has no rule`).toBeDefined();
      }
    }
  });

  test('every detail→detail ownership chain terminates at a component/container within depth 5, acyclically (guarantees A.5\'s transitive resolution can always succeed)', () => {
    // A detail may prefer another detail as its owner (Route → RouteTable),
    // resolved transitively by Ticket A.5 (capped at depth 5). For that to
    // be guaranteed to terminate, every such chain in the *table* must
    // reach a component/container within the cap, never cycle.
    for (const [type, rule] of ruleEntries) {
      if (rule.role !== 'detail' && rule.role !== 'connector') continue;

      // Walk every path through detail-role targets, depth-first.
      const walk = (currentType: string, path: string[]): void => {
        expect(path.length, `${type}: ownership chain ${[...path, currentType].join(' → ')} exceeds transitive-resolution depth 5`).toBeLessThanOrEqual(5);
        expect(path, `${type}: ownership chain cycles: ${[...path, currentType].join(' → ')}`).not.toContain(currentType);
        const currentRule = RULES[currentType]!;
        if (currentRule.role === 'component' || currentRule.role === 'container') return;
        const targets = currentRule.absorbInto ?? [];
        const terminatesSomewhere = targets.some((t) => {
          const r = RULES[t];
          return r !== undefined && (r.role === 'component' || r.role === 'container');
        });
        const resolvesByName = currentRule.ownerByNamePattern !== undefined;
        expect(
          targets.length > 0 || resolvesByName,
          `${type}: chain reaches ${currentType}, which has no way to resolve an owner`,
        ).toBe(true);
        if (!terminatesSomewhere && !resolvesByName) {
          // No direct terminal candidate — every continuation must terminate.
          for (const t of targets) walk(t, [...path, currentType]);
        }
      };
      walk(type, []);
    }
  });

  test('connector specs are well-formed: prop/principal endpoints carry paths, labels are short verbs', () => {
    for (const [type, rule] of ruleEntries) {
      for (const spec of connectorSpecs(rule)) {
        for (const endpoint of [spec.source, spec.target]) {
          if (endpoint.from === 'prop' || endpoint.from === 'principal') {
            expect(endpoint.path.length, `${type}: ${endpoint.from} endpoint needs a non-empty path`).toBeGreaterThan(0);
          }
        }
        expect(spec.label.length, `${type}: connector needs an edge label`).toBeGreaterThan(0);
        expect(spec.kind, `${type}: containment is nesting, never a connector-emitted edge`).not.toBe('containment');
      }
    }
  });

  test('LAYER_ORDER covers the seven flow layers in the PO-approved order, with unique indices', () => {
    expect(LAYER_ORDER.edge).toBeLessThan(LAYER_ORDER.presentation);
    expect(LAYER_ORDER.presentation).toBeLessThan(LAYER_ORDER.auth);
    expect(LAYER_ORDER.auth).toBeLessThan(LAYER_ORDER.api);
    expect(LAYER_ORDER.api).toBeLessThan(LAYER_ORDER.compute);
    expect(LAYER_ORDER.compute).toBeLessThan(LAYER_ORDER.integration);
    expect(LAYER_ORDER.integration).toBeLessThan(LAYER_ORDER.data);
    const indices = Object.values(LAYER_ORDER);
    expect(new Set(indices).size).toBe(indices.length);
  });

  test('PLUMBING_SUFFIXES entries are unique, non-empty, and capitalized (they match against the type\'s last segment)', () => {
    expect(new Set(PLUMBING_SUFFIXES).size).toBe(PLUMBING_SUFFIXES.length);
    for (const suffix of PLUMBING_SUFFIXES) {
      expect(suffix.length).toBeGreaterThan(0);
      expect(suffix[0]).toBe(suffix[0]!.toUpperCase());
    }
  });
});

describe('rule table against the real fixture corpus', () => {
  /** Every resource type occurring across every example fixture on disk. */
  function allFixtureTypes(): Set<string> {
    const { templates } = loadTemplates(allExampleFiles());
    const graph = mergeGraphs(templates);
    const types = new Set<string>();
    for (const node of graph.nodes) {
      if (node.type !== undefined) types.add(node.type);
    }
    return types;
  }

  test('every PLUMBING_SUFFIXES entry is exercised: at least one unruled fixture type matches it (a dead entry means the suffix guards nothing real — remove it or find the fixture that motivates it)', () => {
    const unruledTypes = [...allFixtureTypes()].filter((t) => RULES[t] === undefined);

    const deadSuffixes = PLUMBING_SUFFIXES.filter(
      (suffix) =>
        !unruledTypes.some((t) => {
          const lastSegment = t.split('::').pop() ?? t;
          return lastSegment.endsWith(suffix) && lastSegment !== suffix;
        }),
    );
    expect(deadSuffixes, `dead suffixes (no unruled fixture type matches): ${deadSuffixes.join(', ')}`).toEqual([]);
  });
});
