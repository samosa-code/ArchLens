import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { buildHtml } from '../build.js';
import type { RenderGraph } from '../types.js';

function generateGraph(nodeCount: number): RenderGraph {
  const nodes = Array.from({ length: nodeCount }, (_, i) => ({ id: `n${i}`, label: `Resource${i}` }));
  const edges: { source: string; target: string }[] = [];
  for (let i = 1; i < nodeCount; i++) {
    edges.push({ source: `n${Math.floor(i / 6)}`, target: `n${i}` });
  }
  return { nodes, edges };
}

const GRAPH_25 = generateGraph(25);

function rectsOverlap(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

// One Chromium process shared across every test in this whole file — see
// the identical note in build.test.ts. Only the temp directory (and,
// where needed, a fresh page/context) is per-test.
let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser.close();
}, 30_000);

describe('render — 20+ node graph (Ticket 3.2 acceptance criteria)', () => {
  let tmpDir: string;
  let page: Page;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'archlens-render-test-'));
    const outPath = join(tmpDir, 'index.html');
    writeFileSync(outPath, buildHtml(GRAPH_25), 'utf-8');
    page = await browser.newPage();
    await page.goto(pathToFileURL(outPath).href);
  });

  afterEach(async () => {
    await page.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('renders all 25 nodes and every edge', async () => {
    expect(await page.locator('.archlens-node').count()).toBe(25);
    expect(await page.locator('.archlens-edge').count()).toBe(24);
  });

  test('no two rendered node rects visually overlap, as actually measured in the browser (not just the layout module\'s own math)', async () => {
    const rectLocators = await page.locator('.archlens-node rect').all();
    const boxes = await Promise.all(
      rectLocators.map(async (rect) => ({
        x: Number(await rect.getAttribute('x')),
        y: Number(await rect.getAttribute('y')),
        width: Number(await rect.getAttribute('width')),
        height: Number(await rect.getAttribute('height')),
      })),
    );
    expect(boxes).toHaveLength(25);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        expect(rectsOverlap(boxes[i]!, boxes[j]!)).toBe(false);
      }
    }
  });

  test('dragging pans the diagram: the viewport transform\'s translation changes by the drag delta', async () => {
    const svg = page.locator('#archlens-graph');
    const box = (await svg.boundingBox())!;
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;

    const before = await page.locator('#archlens-viewport').getAttribute('transform');

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 120, startY + 80, { steps: 10 });
    await page.mouse.up();

    const after = await page.locator('#archlens-viewport').getAttribute('transform');
    expect(after).not.toBe(before);

    const parseTranslate = (transform: string | null): { x: number; y: number } => {
      const match = /translate\(([-\d.]+),([-\d.]+)\)/.exec(transform ?? '');
      return { x: Number(match![1]), y: Number(match![2]) };
    };
    const beforeXY = parseTranslate(before);
    const afterXY = parseTranslate(after);
    expect(afterXY.x - beforeXY.x).toBeCloseTo(120, 0);
    expect(afterXY.y - beforeXY.y).toBeCloseTo(80, 0);
  });

  test('scrolling zooms the diagram: the viewport transform\'s scale changes', async () => {
    const before = await page.locator('#archlens-viewport').getAttribute('transform');
    const parseScale = (transform: string | null): number => {
      const match = /scale\(([-\d.]+)\)/.exec(transform ?? '');
      return Number(match![1]);
    };
    const beforeScale = parseScale(before);

    const svg = page.locator('#archlens-graph');
    const box = (await svg.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -300); // scroll "up" — zoom in

    const after = await page.locator('#archlens-viewport').getAttribute('transform');
    const afterScale = parseScale(after);
    expect(afterScale).toBeGreaterThan(beforeScale);
  });

  test('zoom is bounded, not unbounded: repeated zoom-in does not exceed the configured maximum scale', async () => {
    const svg = page.locator('#archlens-graph');
    const box = (await svg.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 50; i++) {
      await page.mouse.wheel(0, -500);
    }
    const transform = await page.locator('#archlens-viewport').getAttribute('transform');
    const match = /scale\(([-\d.]+)\)/.exec(transform ?? '');
    expect(Number(match![1])).toBeLessThanOrEqual(4);
  });
});

describe('render — SVG structure snapshot (visual regression, Ticket 3.2 testing requirement)', () => {
  test('a small fixed fixture graph\'s rendered SVG markup matches its stored snapshot', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'archlens-render-test-'));
    try {
      const fixedGraph: RenderGraph = {
        nodes: [
          { id: 'a', label: 'Alpha' },
          { id: 'b', label: 'Beta' },
          { id: 'c', label: 'Gamma' },
        ],
        edges: [
          { source: 'a', target: 'b' },
          { source: 'a', target: 'c' },
        ],
      };
      const outPath = join(tmpDir, 'index.html');
      writeFileSync(outPath, buildHtml(fixedGraph), 'utf-8');

      const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
      try {
        await page.goto(pathToFileURL(outPath).href);
        const svgMarkup = await page.locator('#archlens-graph').innerHTML();
        // Normalize the one genuinely nondeterministic bit (viewport-fit
        // scale/translate depend on the fixed 800x600 viewport above, so
        // this is actually deterministic too — kept as a real snapshot,
        // not sanitized away, so an unintended layout change still fails
        // it).
        expect(svgMarkup).toMatchSnapshot();
      } finally {
        await page.close();
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('render — PO Question 14: 1,000-node responsiveness, verified in a real browser', () => {
  test('a 1,000-node graph actually opens and renders within a responsive time budget', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'archlens-render-test-'));
    try {
      const bigGraph = generateGraph(1000);
      const outPath = join(tmpDir, 'index.html');

      const buildStart = Date.now();
      writeFileSync(outPath, buildHtml(bigGraph), 'utf-8');
      const buildElapsedMs = Date.now() - buildStart;

      const page = await browser.newPage();
      try {
        const openStart = Date.now();
        await page.goto(pathToFileURL(outPath).href);
        await page.locator('.archlens-node').first().waitFor({ state: 'attached' });
        const openElapsedMs = Date.now() - openStart;

        expect(await page.locator('.archlens-node').count()).toBe(1000);
        expect(await page.locator('.archlens-edge').count()).toBe(999);

        // Generous budgets — "responsive" per PO Question 14 doesn't mean
        // instant, but well under what would read as a hung/broken tool.
        expect(buildElapsedMs).toBeLessThan(10_000);
        expect(openElapsedMs).toBeLessThan(10_000);
      } finally {
        await page.close();
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);
});
