/**
 * `--explain` report generation (Ticket A.10): dumps every
 * {@link AbstractionDecision} plus `unknownTypes` ranked by frequency —
 * turning rule-table growth into a demand-driven loop instead of
 * speculative guessing. Wiring this behind a real `--explain` CLI flag is
 * Ticket 3.4's job (paused until after Sprint 3.5); this module is the
 * report-generation logic that flag will call.
 *
 * Deliberately reports only `arch.decisions` — one line per source
 * `GraphModel` node, matching the accounting invariant exactly. The
 * synthetic Internet/Users node (Ticket A.9) has no source node and no
 * entry in `decisions`; it's a real box on the diagram, not part of this
 * audit log, so it's correctly absent here.
 */
import type { ArchitectureGraph } from './types.js';

export function explainReport(arch: ArchitectureGraph): string {
  const lines: string[] = [];
  lines.push(`${arch.decisions.length} decisions (${arch.stats.sourceNodeCount} source resources accounted for)`);
  lines.push('');
  for (const d of arch.decisions) {
    const absorbedInto = d.absorbedInto !== undefined ? `, absorbed into: ${d.absorbedInto}` : '';
    lines.push(`[${d.action}] ${d.nodeId} — ${d.reason} (rule: ${d.rule}, confidence: ${d.confidence}${absorbedInto})`);
  }
  lines.push('');
  lines.push(`${arch.unknownTypes.length} unknown type(s), ranked by frequency across the input:`);
  for (const type of arch.unknownTypes) {
    lines.push(`  ${type}`);
  }
  return lines.join('\n');
}
