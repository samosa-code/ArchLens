/**
 * Ticket 3.2's browser-side renderer: takes a {@link RenderGraph}, lays it
 * out via `computeLayout()` (`render/layout.ts` — DOM-free, shared with
 * the Node-side unit tests), draws it as SVG, and wires up pan/zoom.
 * Click-to-detail (Ticket 3.3) and real `GraphModel` wiring (Ticket 3.4)
 * are not this ticket's job.
 *
 * Runs under `tsconfig.browser.json` (DOM lib), excluded from the main
 * Node-focused `tsconfig.json`/`tsconfig.build.json` — this file is never
 * compiled by `tsc` into `dist/`, only bundled by `esbuild` directly from
 * source at HTML-build time (see `render/build.ts`).
 */
import { computeLayout, type LayoutResult } from '../layout.js';
import type { RenderGraph } from '../types.js';

/**
 * Replaced textually with a literal JSON value by `esbuild`'s `define` at
 * bundle time — never actually undefined at runtime, but declared as its
 * real shape here so this file typechecks on its own under
 * `tsconfig.browser.json` without needing a build step first.
 */
declare const __ARCHLENS_GRAPH_DATA__: RenderGraph;

const SVG_NS = 'http://www.w3.org/2000/svg';

const NODE_HORIZONTAL_PADDING = 24;
const NODE_HEIGHT = 40;

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

/** Sizes a text-containing box from its *actual rendered* width (see {@link createLabelMeasurer}) — never an estimate, so a label can never overflow its own box. */
function sizeNode(label: string, measureTextWidth: (label: string) => number): { width: number; height: number } {
  const width = Math.max(80, measureTextWidth(label) + NODE_HORIZONTAL_PADDING);
  return { width, height: NODE_HEIGHT };
}

function edgePointsToPathData(points: { x: number; y: number }[]): string {
  if (points.length === 0) return '';
  const [first, ...rest] = points;
  return `M ${first!.x},${first!.y} ` + rest.map((point) => `L ${point.x},${point.y}`).join(' ');
}

function renderSvgContent(graph: RenderGraph, layout: LayoutResult, viewport: SVGGElement): void {
  const labelById = new Map(graph.nodes.map((node) => [node.id, node.label]));

  for (const edge of layout.edges) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', 'archlens-edge');
    path.setAttribute('d', edgePointsToPathData(edge.points));
    path.setAttribute('fill', 'none');
    viewport.appendChild(path);
  }

  for (const [id, position] of layout.nodes) {
    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('class', 'archlens-node');
    group.setAttribute('data-node-id', id);

    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', String(position.x));
    rect.setAttribute('y', String(position.y));
    rect.setAttribute('width', String(position.width));
    rect.setAttribute('height', String(position.height));
    rect.setAttribute('rx', '6');
    group.appendChild(rect);

    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', String(position.x + position.width / 2));
    text.setAttribute('y', String(position.y + position.height / 2));
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'central');
    text.textContent = labelById.get(id) ?? id;
    group.appendChild(text);

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

function render(graph: RenderGraph, mount: HTMLElement): void {
  const measurer = createLabelMeasurer();
  const layoutInput = {
    nodes: graph.nodes.map((node) => ({ id: node.id, ...sizeNode(node.label, measurer.measure) })),
    edges: graph.edges,
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

  renderSvgContent(graph, layout, viewport);
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
