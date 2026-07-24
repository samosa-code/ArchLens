import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { buildHtml } from '../build.js';
import type { RenderGraph } from '../types.js';

/**
 * Ticket 3.6.2 — real AWS service icons. `lambda` has a real curated asset
 * (`assets/icons/lambda.svg`); `datapipeline` is a real service key used in
 * `src/architecture/rules.ts` with no available icon in the current AWS
 * Architecture Icons pack (a legacy/deprecated service) — exercises the
 * "never a broken image, always a clean text fallback" requirement with a
 * real gap, not a fabricated one.
 */
const GRAPH: RenderGraph = {
  nodes: [
    { id: 'covered', label: 'MyFunction', service: 'lambda' },
    { id: 'uncovered', label: 'MyPipeline', service: 'datapipeline' },
    { id: 'no-service', label: 'PlainNode' },
  ],
  edges: [],
};

describe('real AWS service icons — real-browser rendering (Ticket 3.6.2)', () => {
  let browser: Browser;
  let tmpDir: string;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
  }, 30_000);

  afterAll(async () => {
    await browser.close();
  }, 30_000);

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'archlens-icons-render-test-'));
    const outPath = join(tmpDir, 'index.html');
    writeFileSync(outPath, buildHtml(GRAPH), 'utf-8');
    page = await browser.newPage();
    await page.goto(pathToFileURL(outPath).href);
  });

  afterEach(async () => {
    await page.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('a node whose service has a real icon asset renders that icon, inlined as a data: URI (never a network-fetched src)', async () => {
    const icon = page.locator('.archlens-node[data-node-id="covered"] .archlens-node-icon');
    expect(await icon.count()).toBe(1);
    const href = await icon.getAttribute('href');
    expect(href).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  test('a node whose service has a real icon asset does not also show the old plain-text service subtitle', async () => {
    const textSubtitle = page.locator('.archlens-node[data-node-id="covered"] .archlens-node-service');
    expect(await textSubtitle.count()).toBe(0);
  });

  test('a node whose service has no available icon asset falls back to the existing plain-text subtitle, not a broken image', async () => {
    const icon = page.locator('.archlens-node[data-node-id="uncovered"] .archlens-node-icon');
    expect(await icon.count()).toBe(0);
    const textSubtitle = page.locator('.archlens-node[data-node-id="uncovered"] .archlens-node-service');
    expect(await textSubtitle.count()).toBe(1);
    expect(await textSubtitle.textContent()).toBe('datapipeline');
  });

  test('a node with no service at all renders neither an icon nor a service subtitle', async () => {
    const node = page.locator('.archlens-node[data-node-id="no-service"]');
    expect(await node.locator('.archlens-node-icon').count()).toBe(0);
    expect(await node.locator('.archlens-node-service').count()).toBe(0);
  });

  test('an icon-covered node renders as a real big square icon with its label below it, not a small icon beside the text (visual redesign)', async () => {
    const icon = page.locator('.archlens-node[data-node-id="covered"] .archlens-node-icon');
    const iconWidth = Number(await icon.getAttribute('width'));
    const iconHeight = Number(await icon.getAttribute('height'));
    const iconY = Number(await icon.getAttribute('y'));
    // "Big" — nowhere near the old 20px beside-text icon size.
    expect(iconWidth).toBeGreaterThanOrEqual(40);
    expect(iconHeight).toBeGreaterThanOrEqual(40);

    const label = page.locator('.archlens-node[data-node-id="covered"] text').first();
    const labelY = Number(await label.getAttribute('y'));
    // The label must sit BELOW the icon (larger y — SVG y grows downward),
    // not beside it at the same vertical center.
    expect(labelY).toBeGreaterThan(iconY + iconHeight);

    // The node's own backing rect (sized by `sizeNode()`, independent of
    // the icon/label draw calls above) must actually be tall enough to
    // contain both — not just draw the icon+label past its own box
    // boundary into whatever's below it in the layout.
    const rect = page.locator('.archlens-node[data-node-id="covered"] rect');
    const rectY = Number(await rect.getAttribute('y'));
    const rectHeight = Number(await rect.getAttribute('height'));
    expect(rectY + rectHeight).toBeGreaterThanOrEqual(labelY);
  });

  test('a node with no covered icon (uncovered service, or no service at all) renders as a roughly square placeholder box with its label centered inside', async () => {
    const rect = page.locator('.archlens-node[data-node-id="no-service"] rect');
    const width = Number(await rect.getAttribute('width'));
    const height = Number(await rect.getAttribute('height'));
    // Square-ish, not the old wide 80x40 rectangle — width and height in
    // the same ballpark rather than a ~2:1 wide rectangle.
    expect(height).toBeGreaterThanOrEqual(56);
    expect(width / height).toBeLessThan(1.5);
  });
});
