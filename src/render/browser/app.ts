/**
 * Ticket 3.2's browser-side renderer: takes a {@link RenderGraph}, lays it
 * out via `computeLayout()` (`render/layout.ts` — DOM-free, shared with
 * the Node-side unit tests), draws it as SVG, and wires up pan/zoom.
 * Ticket 3.3 adds click-for-details: clicking a node populates and shows
 * `#archlens-panel` (a static skeleton in `template.html`, toggled via its
 * `hidden` attribute — never built fresh per click) with the node's
 * header, security-finding callout, grouped absorbed-resource sections,
 * and Connections. Real `GraphModel`/CLI wiring is still Ticket 3.4's job.
 *
 * Runs under `tsconfig.browser.json` (DOM lib), excluded from the main
 * Node-focused `tsconfig.json`/`tsconfig.build.json` — this file is never
 * compiled by `tsc` into `dist/`, only bundled by `esbuild` directly from
 * source at HTML-build time (see `render/build.ts`).
 */
import { computeLayout, type LayoutResult } from '../layout.js';
import type { RenderContainer, RenderGraph, RenderNode } from '../types.js';

/** Fixed, stable order the detail panel's collapsible sections render in — an absorbed-resource group with nothing in it is omitted entirely, never shown empty. */
const ABSORBED_GROUP_ORDER = ['permissions', 'networking', 'observability', 'lifecycle', 'plumbing'] as const;

/**
 * Replaced textually with a literal JSON value by `esbuild`'s `define` at
 * bundle time — never actually undefined at runtime, but declared as its
 * real shape here so this file typechecks on its own under
 * `tsconfig.browser.json` without needing a build step first.
 */
declare const __ARCHLENS_GRAPH_DATA__: RenderGraph;

/**
 * `{serviceKey: data-URI}` — every `.svg` under `assets/icons/` at build
 * time, keyed by filename (`icons.ts`'s `loadIconDataUris()`), baked in the
 * same way as `__ARCHLENS_GRAPH_DATA__` above. Coverage is intentionally
 * partial (Ticket 3.6.2): a `RenderNode.service` with no entry here falls
 * back to the pre-existing plain-text subtitle, never a broken image.
 */
declare const __ARCHLENS_ICON_DATA__: Record<string, string>;

const SVG_NS = 'http://www.w3.org/2000/svg';

const NODE_HORIZONTAL_PADDING = 24;
/**
 * Real service icon nodes (Ticket 3.6.3's visual redesign, matching a
 * reference AWS-style diagram): a big square icon as the node's primary
 * visual — its own real color/shape, not a small glyph beside the text —
 * with the label centered below it. A node with no covered icon instead
 * gets a plain square placeholder box (`NODE_PLACEHOLDER_SIZE`) with its
 * label centered inside, so every node in a diagram reads as "a box" of a
 * broadly consistent size, whether or not it has real icon coverage.
 */
const NODE_ICON_SIZE = 56;
const NODE_ICON_LABEL_GAP = 8;
const NODE_LABEL_LINE_HEIGHT = 16;
const NODE_ICON_HORIZONTAL_PADDING = 12;
const NODE_PLACEHOLDER_SIZE = 64;
/** A container needs room for its label to sit at the top without overlapping its first member row — real content still auto-expands well beyond this floor (Ticket 3.6.1; confirmed directly against `@dagrejs/dagre`, see `layout.ts`). */
const CONTAINER_HORIZONTAL_PADDING = 32;
const CONTAINER_MIN_HEIGHT = 50;

/**
 * A hidden, off-screen `<text>` element used only to measure real label
 * widths via `getComputedTextLength()` — `visibility: hidden` (not
 * `display: none`) deliberately, since a `display: none` subtree isn't
 * laid out at all and would make text measurement return 0. Nested inside
 * a `.archlens-node` group so `style.css`'s `.archlens-node text` rule
 * (font-size) applies identically to the measurement as it will to the
 * real rendered label — otherwise the measurement wouldn't match reality
 * any better than a guess.
 *
 * Sizing was originally a character-count heuristic capped at a fixed
 * maximum width — found (via a real user report, then confirmed directly
 * against real fixture data) to badly overflow on real CloudFormation
 * logical IDs, some 70 characters long once the resource type is
 * appended. Real measurement has no such failure mode: the box is always
 * exactly as wide as the label actually renders.
 */
function createLabelMeasurer(): { measure: (label: string) => number; cleanup: () => void } {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('style', 'position:absolute; visibility:hidden; width:0; height:0; overflow:hidden;');
  const group = document.createElementNS(SVG_NS, 'g');
  group.setAttribute('class', 'archlens-node');
  const text = document.createElementNS(SVG_NS, 'text');
  group.appendChild(text);
  svg.appendChild(group);
  document.body.appendChild(svg);

  return {
    measure(label: string): number {
      text.textContent = label;
      return text.getComputedTextLength();
    },
    cleanup(): void {
      svg.remove();
    },
  };
}

/**
 * Sizes a node's box from its label's *actual rendered* width (see
 * {@link createLabelMeasurer}) — never an estimate, so a label can never
 * overflow its own box. Two distinct shapes (Ticket 3.6.3's visual
 * redesign):
 *
 * - `hasIcon`: a big square icon on top, label below it — width grows
 *   past the icon's own size only if the label genuinely needs more room;
 *   height is always icon + gap + one label line.
 * - no icon: a roughly square placeholder box, label centered inside —
 *   `NODE_PLACEHOLDER_SIZE` is a floor, not a fixed size, so a longer label
 *   still gets the width it needs without wrapping.
 */
function sizeNode(label: string, measureTextWidth: (label: string) => number, hasIcon: boolean): { width: number; height: number } {
  if (hasIcon) {
    const width = Math.max(NODE_ICON_SIZE, measureTextWidth(label) + NODE_ICON_HORIZONTAL_PADDING * 2);
    const height = NODE_ICON_SIZE + NODE_ICON_LABEL_GAP + NODE_LABEL_LINE_HEIGHT;
    return { width, height };
  }
  const width = Math.max(NODE_PLACEHOLDER_SIZE, measureTextWidth(label) + NODE_HORIZONTAL_PADDING);
  return { width, height: NODE_PLACEHOLDER_SIZE };
}

/** A container's *minimum* size (see `LayoutContainerInput`'s own doc comment for why this is a floor, not a fixed size) — sized from its label exactly like a real node. */
function sizeContainer(label: string, measureTextWidth: (label: string) => number): { minWidth: number; minHeight: number } {
  const minWidth = Math.max(120, measureTextWidth(label) + CONTAINER_HORIZONTAL_PADDING);
  return { minWidth, minHeight: CONTAINER_MIN_HEIGHT };
}

function edgePointsToPathData(points: { x: number; y: number }[]): string {
  if (points.length === 0) return '';
  const [first, ...rest] = points;
  return `M ${first!.x},${first!.y} ` + rest.map((point) => `L ${point.x},${point.y}`).join(' ');
}

/** Queues every `RenderEdge` between the same (source, target) pair, so parallel edges (dagre multigraph) each get their own styling rather than all reusing the first match. */
function buildEdgeQueueByPair(edges: RenderGraph['edges']): Map<string, RenderGraph['edges']> {
  const byPair = new Map<string, RenderGraph['edges']>();
  for (const edge of edges) {
    const key = `${edge.source}->${edge.target}`;
    const list = byPair.get(key) ?? [];
    list.push(edge);
    byPair.set(key, list);
  }
  return byPair;
}

/** Root containers first, then depth 1, depth 2, ... — so a parent's boundary is drawn (and thus painted) before its child's, which then reads as visibly nested on top of it. */
function sortContainersByDepth(containers: RenderContainer[]): RenderContainer[] {
  const byId = new Map(containers.map((c) => [c.id, c]));
  const depthOf = (id: string): number => {
    let depth = 0;
    let current = byId.get(id);
    while (current?.parentId !== undefined) {
      depth += 1;
      current = byId.get(current.parentId);
    }
    return depth;
  };
  return [...containers].sort((a, b) => depthOf(a.id) - depthOf(b.id));
}

function renderSvgContent(graph: RenderGraph, layout: LayoutResult, viewport: SVGGElement, onNodeClick: (nodeId: string) => void): void {
  const labelById = new Map(graph.nodes.map((node) => [node.id, node.label]));
  const edgeQueueByPair = buildEdgeQueueByPair(graph.edges);

  // Containers render first (backmost layer, Ticket 3.6.1) — parents
  // before children, so nesting reads correctly; edges and nodes always
  // paint on top of every boundary.
  const containerLabelById = new Map((graph.containers ?? []).map((c) => [c.id, c.label]));
  for (const container of sortContainersByDepth(graph.containers ?? [])) {
    const position = layout.containers.get(container.id);
    if (position === undefined) continue; // never silently draws a container with no computed position, but also never throws over one

    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('class', 'archlens-container');
    group.setAttribute('data-container-id', container.id);
    group.setAttribute('data-container-kind', container.kind);

    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', String(position.x));
    rect.setAttribute('y', String(position.y));
    rect.setAttribute('width', String(position.width));
    rect.setAttribute('height', String(position.height));
    rect.setAttribute('rx', '8');
    group.appendChild(rect);

    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('class', 'archlens-container-label');
    label.setAttribute('x', String(position.x + 10));
    label.setAttribute('y', String(position.y + 18));
    label.textContent = containerLabelById.get(container.id) ?? container.id;
    group.appendChild(label);

    viewport.appendChild(group);
  }

  for (const edge of layout.edges) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', 'archlens-edge');
    path.setAttribute('d', edgePointsToPathData(edge.points));
    path.setAttribute('fill', 'none');

    // Edge kind -> line style (delivery specifically — sync solid, async
    // dashed, per PO Question 23). Best-effort pairing by (source,target):
    // a rare same-pair, different-kind parallel edge could get the wrong
    // one queued here, a cosmetic-only risk — the Connections panel
    // (which reads `graph.edges` directly, never this queue) is exact.
    const queue = edgeQueueByPair.get(`${edge.source}->${edge.target}`);
    const info = queue?.shift();
    if (info?.kind !== undefined) path.setAttribute('data-kind', info.kind);
    if (info?.delivery !== undefined) path.setAttribute('data-delivery', info.delivery);

    viewport.appendChild(path);
  }

  for (const [id, position] of layout.nodes) {
    const node = graph.nodes.find((n) => n.id === id);
    const iconDataUri = node?.service !== undefined ? __ARCHLENS_ICON_DATA__[node.service] : undefined;

    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('class', iconDataUri !== undefined ? 'archlens-node archlens-node--icon' : 'archlens-node');
    group.setAttribute('data-node-id', id);
    if (node?.service !== undefined) group.setAttribute('data-service', node.service);
    group.addEventListener('click', () => onNodeClick(id));

    // A full-bbox backing rect on every node, icon or not — the real click
    // hit-area, and what every existing overlap/geometry test already
    // expects one-per-node. Visibly styled as the classic bordered box for
    // a no-icon node; made invisible by `.archlens-node--icon rect` in
    // `style.css` for an icon node, where the icon + label below it are the
    // whole visible node, not a bordered card around them (Ticket 3.6.3's
    // visual redesign, matching a supplied reference diagram).
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', String(position.x));
    rect.setAttribute('y', String(position.y));
    rect.setAttribute('width', String(position.width));
    rect.setAttribute('height', String(position.height));
    rect.setAttribute('rx', '6');
    group.appendChild(rect);

    if (iconDataUri !== undefined) {
      const icon = document.createElementNS(SVG_NS, 'image');
      icon.setAttribute('class', 'archlens-node-icon');
      icon.setAttribute('x', String(position.x + (position.width - NODE_ICON_SIZE) / 2));
      icon.setAttribute('y', String(position.y));
      icon.setAttribute('width', String(NODE_ICON_SIZE));
      icon.setAttribute('height', String(NODE_ICON_SIZE));
      icon.setAttribute('href', iconDataUri);
      group.appendChild(icon);

      const label = document.createElementNS(SVG_NS, 'text');
      label.setAttribute('x', String(position.x + position.width / 2));
      label.setAttribute('y', String(position.y + NODE_ICON_SIZE + NODE_ICON_LABEL_GAP + NODE_LABEL_LINE_HEIGHT / 2));
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('dominant-baseline', 'central');
      label.textContent = labelById.get(id) ?? id;
      group.appendChild(label);
    } else {
      const hasServiceSubtitle = node?.service !== undefined;
      const label = document.createElementNS(SVG_NS, 'text');
      label.setAttribute('x', String(position.x + position.width / 2));
      label.setAttribute('y', String(position.y + position.height / 2 - (hasServiceSubtitle ? 6 : 0)));
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('dominant-baseline', 'central');
      label.textContent = labelById.get(id) ?? id;
      group.appendChild(label);

      if (hasServiceSubtitle) {
        const serviceText = document.createElementNS(SVG_NS, 'text');
        serviceText.setAttribute('class', 'archlens-node-service');
        serviceText.setAttribute('x', String(position.x + position.width / 2));
        serviceText.setAttribute('y', String(position.y + position.height / 2 + 10));
        serviceText.setAttribute('text-anchor', 'middle');
        serviceText.setAttribute('dominant-baseline', 'central');
        serviceText.textContent = node!.service!;
        group.appendChild(serviceText);
      }
    }

    viewport.appendChild(group);
  }
}

interface ViewportState {
  x: number;
  y: number;
  scale: number;
}

const MIN_SCALE = 0.05;
const MAX_SCALE = 4;

function applyTransform(viewport: SVGGElement, state: ViewportState): void {
  viewport.setAttribute('transform', `translate(${state.x},${state.y}) scale(${state.scale})`);
}

/** Scales/centers the diagram to fit the viewport on first render — otherwise a large (e.g. 1,000-node) diagram would open showing only a small corner of itself with no orientation. */
function computeInitialViewport(diagramWidth: number, diagramHeight: number, viewportWidth: number, viewportHeight: number): ViewportState {
  if (diagramWidth === 0 || diagramHeight === 0) return { x: 0, y: 0, scale: 1 };
  const scale = Math.min(viewportWidth / diagramWidth, viewportHeight / diagramHeight, 1) * 0.9;
  return {
    scale,
    x: (viewportWidth - diagramWidth * scale) / 2,
    y: (viewportHeight - diagramHeight * scale) / 2,
  };
}

/**
 * Drag-to-pan (pointer events) and wheel-to-zoom (cursor-anchored, so the
 * point under the mouse stays fixed as scale changes) — a small,
 * dependency-free implementation rather than pulling in d3-zoom; see
 * ADR 0006 for why.
 */
function setupPanZoom(svg: SVGSVGElement, viewport: SVGGElement, initial: ViewportState): void {
  let state = initial;
  applyTransform(viewport, state);

  let dragging = false;
  let lastClientX = 0;
  let lastClientY = 0;

  svg.addEventListener('pointerdown', (event) => {
    // A pointerdown starting on a node must not capture the pointer: per
    // spec, capturing redirects the matching pointerup (and the mouseup
    // synthesized from it) to `svg`, which means the browser's own
    // mousedown-target/mouseup-target-based `click` synthesis never fires
    // on the node itself — silently breaking Ticket 3.3's click-for-
    // details entirely. Confirmed directly: dispatching a synthetic
    // 'click' event worked, but Playwright's real mouse-simulated click
    // did not, until this check was added. Dragging still works from
    // anywhere on the empty canvas — only node-originated presses skip it.
    if ((event.target as Element).closest('.archlens-node') !== null) return;
    dragging = true;
    lastClientX = event.clientX;
    lastClientY = event.clientY;
    svg.setPointerCapture(event.pointerId);
  });

  svg.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const dx = event.clientX - lastClientX;
    const dy = event.clientY - lastClientY;
    lastClientX = event.clientX;
    lastClientY = event.clientY;
    state = { ...state, x: state.x + dx, y: state.y + dy };
    applyTransform(viewport, state);
  });

  const stopDragging = (): void => {
    dragging = false;
  };
  svg.addEventListener('pointerup', stopDragging);
  svg.addEventListener('pointerleave', stopDragging);

  svg.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      const cursorX = event.clientX - rect.left;
      const cursorY = event.clientY - rect.top;
      const zoomFactor = Math.exp(-event.deltaY * 0.001);
      const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, state.scale * zoomFactor));

      // Keep the point under the cursor fixed: its "world" coordinate
      // (independent of the current transform) must map to the same
      // screen coordinate before and after the scale change.
      const worldX = (cursorX - state.x) / state.scale;
      const worldY = (cursorY - state.y) / state.scale;
      state = { scale: newScale, x: cursorX - worldX * newScale, y: cursorY - worldY * newScale };
      applyTransform(viewport, state);
    },
    { passive: false },
  );
}

/** Replaces `container`'s children with `children` — used throughout the panel so re-clicking a different node replaces content rather than stacking onto it. */
function replaceChildren(container: Element, children: Element[]): void {
  container.replaceChildren(...children);
}

function buildConnectionRows(node: RenderNode, graph: RenderGraph): Element[] {
  const labelById = new Map(graph.nodes.map((n) => [n.id, n.label]));
  const serviceById = new Map(graph.nodes.map((n) => [n.id, n.service]));

  return graph.edges
    .filter((edge) => edge.source === node.id || edge.target === node.id)
    .map((edge) => {
      const outbound = edge.source === node.id;
      const otherId = outbound ? edge.target : edge.source;
      const otherLabel = labelById.get(otherId) ?? otherId;
      const otherService = serviceById.get(otherId);
      const verb = edge.label ?? edge.kind ?? 'connects to';

      const row = document.createElement('div');
      row.className = 'archlens-panel-connection';
      row.textContent = `${verb} ${outbound ? '→' : '←'} ${otherLabel}${otherService !== undefined ? ` (${otherService})` : ''}`;
      return row;
    });
}

/** One collapsible section per {@link ABSORBED_GROUP_ORDER} entry — omitted entirely (never rendered empty) when a node has nothing absorbed into that group. */
function buildSectionElements(node: RenderNode): Element[] {
  const absorbed = node.absorbed ?? [];
  return ABSORBED_GROUP_ORDER.flatMap((group) => {
    const items = absorbed.filter((a) => a.group === group);
    if (items.length === 0) return [];

    const section = document.createElement('div');
    section.className = 'archlens-panel-section';
    section.dataset.group = group;

    const header = document.createElement('div');
    header.className = 'archlens-panel-section-header';
    const countBadge = document.createElement('span');
    countBadge.className = 'archlens-panel-section-count';
    countBadge.textContent = String(items.length);
    header.append(`${group} `, countBadge);
    section.appendChild(header);

    for (const item of items) {
      const row = document.createElement('div');
      row.className = item.hasFinding ? 'archlens-panel-item archlens-panel-item--finding' : 'archlens-panel-item';
      row.textContent = `${item.logicalId} (${item.resourceType})`;
      section.appendChild(row);
    }

    return [section];
  });
}

function showPanel(panel: HTMLElement, node: RenderNode, graph: RenderGraph): void {
  panel.querySelector('.archlens-panel-title')!.textContent = node.label;
  panel.querySelector('.archlens-panel-subtitle')!.textContent = [node.type, node.layer].filter((v) => v !== undefined).join(' · ');
  panel.querySelector('.archlens-panel-source')!.textContent = node.file !== undefined && node.line !== undefined ? `${node.file}:${node.line}` : '';

  // Security-finding callout: shown only when this node actually has a
  // finding — never presented for every node (PO Question 24's spirit
  // applied at the node level too).
  const findings = panel.querySelector('.archlens-panel-findings') as HTMLElement;
  const badges = node.badges ?? [];
  const findingRows = badges.map((badge) => {
    const row = document.createElement('div');
    row.textContent = badge.message;
    return row;
  });
  replaceChildren(findings, findingRows);
  findings.hidden = badges.length === 0;

  replaceChildren(panel.querySelector('.archlens-panel-sections')!, buildSectionElements(node));
  replaceChildren(panel.querySelector('.archlens-panel-connections')!, buildConnectionRows(node, graph));

  panel.hidden = false;
}

/** Wires the close button once and returns the click handler `renderSvgContent` calls per node — looks the clicked id up in `graph` fresh each time, so it always reflects the current graph, not a stale closure. */
function setupPanel(graph: RenderGraph): (nodeId: string) => void {
  const panel = document.getElementById('archlens-panel');
  if (panel === null) throw new Error('ArchLens: missing #archlens-panel in the HTML template');
  document.getElementById('archlens-panel-close')?.addEventListener('click', () => {
    panel.hidden = true;
  });

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  return (nodeId: string): void => {
    const node = nodeById.get(nodeId);
    if (node === undefined) return;
    showPanel(panel, node, graph);
  };
}

function render(graph: RenderGraph, mount: HTMLElement): void {
  const measurer = createLabelMeasurer();
  const layoutInput = {
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      ...sizeNode(node.label, measurer.measure, node.service !== undefined && __ARCHLENS_ICON_DATA__[node.service] !== undefined),
      ...(node.containerId === undefined ? {} : { containerId: node.containerId }),
    })),
    edges: graph.edges,
    ...(graph.containers === undefined
      ? {}
      : {
          containers: graph.containers.map((container) => ({
            id: container.id,
            ...(container.parentId === undefined ? {} : { parentId: container.parentId }),
            ...sizeContainer(container.label, measurer.measure),
          })),
        }),
  };
  measurer.cleanup();

  const layout = computeLayout(layoutInput);

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('id', 'archlens-graph');
  svg.setAttribute('width', String(window.innerWidth));
  svg.setAttribute('height', String(window.innerHeight));

  const viewport = document.createElementNS(SVG_NS, 'g');
  viewport.setAttribute('id', 'archlens-viewport');
  svg.appendChild(viewport);

  const onNodeClick = setupPanel(graph);
  renderSvgContent(graph, layout, viewport, onNodeClick);
  mount.appendChild(svg);

  const initialViewport = computeInitialViewport(layout.width, layout.height, window.innerWidth, window.innerHeight);
  setupPanZoom(svg, viewport, initialViewport);

  window.addEventListener('resize', () => {
    svg.setAttribute('width', String(window.innerWidth));
    svg.setAttribute('height', String(window.innerHeight));
  });
}

const mountElement = document.getElementById('archlens-app');
if (mountElement === null) {
  throw new Error('ArchLens: missing #archlens-app mount element in the HTML template');
}
render(__ARCHLENS_GRAPH_DATA__, mountElement);
