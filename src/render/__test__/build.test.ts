import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { buildHtml } from '../build.js';
import type { RenderGraph } from '../types.js';

const SAMPLE_GRAPH: RenderGraph = {
  nodes: [
    { id: 'a', label: 'BucketA' },
    { id: 'b', label: 'FunctionB' },
    { id: 'c', label: 'RoleC' },
  ],
  edges: [
    { source: 'b', target: 'a' },
    { source: 'b', target: 'c' },
  ],
};

describe('buildHtml — static structure checks', () => {
  test('produces a single string with no external <script src> or <link href> references', () => {
    const html = buildHtml(SAMPLE_GRAPH);
    expect(html).not.toMatch(/<script[^>]+\bsrc=/i);
    expect(html).not.toMatch(/<link[^>]+\bhref=/i);
  });

  test('embeds the graph data as a literal inside the bundled script, not a separate fetchable blob', () => {
    const html = buildHtml(SAMPLE_GRAPH);
    // The label must appear directly in the HTML text (baked into the JS
    // bundle by esbuild's `define`), not merely referenced by a path.
    expect(html).toContain('FunctionB');
    expect(html).not.toMatch(/\.json["']/);
  });

  test('two builds from different graphs produce different output (data is genuinely baked in per call, not cached)', () => {
    const htmlA = buildHtml(SAMPLE_GRAPH);
    const htmlB = buildHtml({ nodes: [{ id: 'x', label: 'SomethingElse' }], edges: [] });
    expect(htmlA).not.toBe(htmlB);
    expect(htmlB).toContain('SomethingElse');
    expect(htmlA).not.toContain('SomethingElse');
  });
});

describe('buildHtml — real headless-browser verification (Ticket 3.1 acceptance criteria)', () => {
  // One Chromium process shared across every test in this file — launching
  // a fresh browser per test was the dominant cost once more browser-test
  // files were added (Ticket 3.2), making the whole suite's parallel run
  // contend for resources and making unrelated tests flaky under load.
  // Only `tmpDir` (cheap, filesystem-only) is still per-test.
  let browser: Browser;
  let tmpDir: string;

  beforeAll(async () => {
    browser = await chromium.launch();
  }, 30_000);

  afterAll(async () => {
    await browser.close();
  }, 30_000);

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'archlens-render-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSample(): string {
    const outPath = join(tmpDir, 'index.html');
    writeFileSync(outPath, buildHtml(SAMPLE_GRAPH), 'utf-8');
    return outPath;
  }

  test('opening the generated file makes zero network requests beyond the initial file:// navigation itself', async () => {
    const outPath = writeSample();
    const page = await browser.newPage();
    const requestedUrls: string[] = [];
    page.on('request', (req) => requestedUrls.push(req.url()));

    const navigationUrl = pathToFileURL(outPath).href;
    await page.goto(navigationUrl);

    const otherRequests = requestedUrls.filter((url) => url !== navigationUrl);
    expect(otherRequests).toEqual([]);
  });

  test('works identically with the browser context fully offline — the AC\'s own stated verification method', async () => {
    const outPath = writeSample();
    const context = await browser.newContext({ offline: true });
    const page = await context.newPage();

    await page.goto(pathToFileURL(outPath).href);
    const nodeCount = await page.locator('.archlens-node').count();

    expect(nodeCount).toBe(3);
    await context.close();
  });

  test('the graph actually renders: correct node/edge counts and labels appear in the real DOM', async () => {
    const outPath = writeSample();
    const page = await browser.newPage();
    await page.goto(pathToFileURL(outPath).href);

    expect(await page.locator('.archlens-node').count()).toBe(3);
    expect(await page.locator('.archlens-edge').count()).toBe(2);

    const labels = await page.locator('.archlens-node text').allTextContents();
    expect(labels.sort()).toEqual(['BucketA', 'FunctionB', 'RoleC']);
  });

  test('the page reports zero console errors', async () => {
    const outPath = writeSample();
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto(pathToFileURL(outPath).href);
    expect(errors).toEqual([]);
  });
});
