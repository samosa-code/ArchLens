import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { glob } from 'glob';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { loadTemplates } from '../../parser/loader.js';
import { mergeGraphs } from '../../graph/merge.js';
import { generate } from '../../architecture/generate.js';
import { architectureGraphToRenderGraph } from '../fromArchitectureGraph.js';
import { buildHtml } from '../build.js';
import type { RenderGraph } from '../types.js';

/**
 * Ticket 3.6.1 — real-fixture regression coverage for container rendering.
 * Runs the actual `loadTemplates -> mergeGraphs -> generate ->
 * architectureGraphToRenderGraph` pipeline (the same one `cli.ts` runs)
 * against real example templates, then opens the built HTML in a real
 * browser and checks the rendered SVG — not just `layout.ts`'s own math.
 */
async function buildRenderGraphFromExamples(patterns: string[]): Promise<RenderGraph> {
  const normalized = patterns.map((p) => p.replace(/\\/g, '/'));
  const files = (await Promise.all(normalized.map((p) => glob(p, { absolute: true, nodir: true })))).flat();
  const { templates } = loadTemplates(files);
  const graph = mergeGraphs(templates);
  const arch = generate(graph);
  return architectureGraphToRenderGraph(arch);
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function contains(outer: Box, inner: Box): boolean {
  return (
    inner.x >= outer.x - 0.001 &&
    inner.y >= outer.y - 0.001 &&
    inner.x + inner.width <= outer.x + outer.width + 0.001 &&
    inner.y + inner.height <= outer.y + outer.height + 0.001
  );
}

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser.close();
}, 30_000);

async function openRenderGraph(renderGraph: RenderGraph): Promise<{ page: import('playwright').Page; cleanup: () => void }> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'archlens-containers-test-'));
  const outPath = join(tmpDir, 'index.html');
  writeFileSync(outPath, buildHtml(renderGraph), 'utf-8');
  const page = await browser.newPage();
  await page.goto(pathToFileURL(outPath).href);
  return {
    page,
    cleanup: () => rmSync(tmpDir, { recursive: true, force: true }),
  };
}

/**
 * Real fixture ids are absolute Windows file paths (`C:\Users\...#VPC`) —
 * embedding raw backslashes in a CSS attribute-selector string is unsafe
 * (backslash is CSS's own string-escape character, so `\U`/`\D`/etc would
 * silently get eaten by the browser's own CSS parser rather than matching
 * literally). Reading every element's `data-*` id via JS and building a
 * plain id -> box map sidesteps CSS escaping entirely.
 */
async function containerBoxesById(page: import('playwright').Page): Promise<Map<string, Box>> {
  const rows = await page.locator('.archlens-container').evaluateAll((groups) =>
    groups.map((g) => {
      const rect = g.querySelector('rect')!;
      return {
        id: g.getAttribute('data-container-id')!,
        x: Number(rect.getAttribute('x')),
        y: Number(rect.getAttribute('y')),
        width: Number(rect.getAttribute('width')),
        height: Number(rect.getAttribute('height')),
      };
    }),
  );
  return new Map(rows.map(({ id, ...box }) => [id, box]));
}

async function nodeBoxesById(page: import('playwright').Page): Promise<Map<string, Box>> {
  const rows = await page.locator('.archlens-node').evaluateAll((groups) =>
    groups.map((g) => {
      const rect = g.querySelector('rect')!;
      return {
        id: g.getAttribute('data-node-id')!,
        x: Number(rect.getAttribute('x')),
        y: Number(rect.getAttribute('y')),
        width: Number(rect.getAttribute('width')),
        height: Number(rect.getAttribute('height')),
      };
    }),
  );
  return new Map(rows.map(({ id, ...box }) => [id, box]));
}

describe('container rendering — real fixtures (Ticket 3.6.1)', () => {
  test('examples/02-complex-vpc-nat: the exact "blank canvas" bug — zero component nodes, but 5 real nested boundary rectangles render', async () => {
    const renderGraph = await buildRenderGraphFromExamples(['examples/02-complex-vpc-nat/template.yaml']);
    expect(renderGraph.nodes).toHaveLength(0);
    expect(renderGraph.containers).toHaveLength(5);

    const { page, cleanup } = await openRenderGraph(renderGraph);
    try {
      expect(await page.locator('.archlens-node').count()).toBe(0);
      expect(await page.locator('.archlens-container').count()).toBe(5);

      const vpc = renderGraph.containers!.find((c) => c.kind === 'vpc')!;
      const subnets = renderGraph.containers!.filter((c) => c.kind === 'subnet');
      expect(subnets).toHaveLength(4);

      const boxes = await containerBoxesById(page);
      const vpcBox = boxes.get(vpc.id)!;
      for (const subnet of subnets) {
        expect(contains(vpcBox, boxes.get(subnet.id)!)).toBe(true);
      }
    } finally {
      await page.close();
      cleanup();
    }
  }, 30_000);

  test('examples/03-multi-stack-ecs-fargate: real component nodes nest visually inside their real containers, across a 2-level VPC > Subnet chain', async () => {
    const renderGraph = await buildRenderGraphFromExamples(['examples/03-multi-stack-ecs-fargate/**/template.yaml']);
    expect(renderGraph.containers).toHaveLength(4);

    const { page, cleanup } = await openRenderGraph(renderGraph);
    try {
      const vpc = renderGraph.containers!.find((c) => c.kind === 'vpc')!;
      const publicSubnetOne = renderGraph.containers!.find((c) => c.kind === 'subnet' && c.parentId === vpc.id)!;
      const ecsCluster = renderGraph.containers!.find((c) => c.kind === 'cluster')!;

      const containerBoxes = await containerBoxesById(page);
      const nodeBoxes = await nodeBoxesById(page);

      const vpcBox = containerBoxes.get(vpc.id)!;
      const subnetBox = containerBoxes.get(publicSubnetOne.id)!;
      expect(contains(vpcBox, subnetBox)).toBe(true);

      // Every real node whose `containerId` is this subnet must land
      // geometrically inside it — not just get a `containerId` in the
      // data model that nothing ever draws.
      const subnetMembers = renderGraph.nodes.filter((n) => n.containerId === publicSubnetOne.id);
      expect(subnetMembers.length).toBeGreaterThan(0);
      for (const member of subnetMembers) {
        expect(contains(subnetBox, nodeBoxes.get(member.id)!)).toBe(true);
      }

      // ECSCluster is a separate, unrelated container (no parentId) with
      // its own real member — must enclose it too, independent of the
      // VPC/Subnet chain above.
      const clusterBox = containerBoxes.get(ecsCluster.id)!;
      const clusterMembers = renderGraph.nodes.filter((n) => n.containerId === ecsCluster.id);
      expect(clusterMembers.length).toBeGreaterThan(0);
      for (const member of clusterMembers) {
        expect(contains(clusterBox, nodeBoxes.get(member.id)!)).toBe(true);
      }
    } finally {
      await page.close();
      cleanup();
    }
  }, 30_000);

  test('examples/06-nested-stack-quickstart: two separate nested-stack boundaries (VPCStack > BastionStack) both render, nested correctly', async () => {
    const renderGraph = await buildRenderGraphFromExamples(['examples/06-nested-stack-quickstart/*.yaml']);
    const stackContainers = renderGraph.containers!.filter((c) => c.kind === 'stack');
    expect(stackContainers).toHaveLength(2);

    const { page, cleanup } = await openRenderGraph(renderGraph);
    try {
      expect(await page.locator('.archlens-container').count()).toBe(renderGraph.containers!.length);

      const vpcStack = stackContainers.find((c) => c.parentId === undefined)!;
      const bastionStack = stackContainers.find((c) => c.parentId === vpcStack.id)!;
      expect(bastionStack).toBeDefined();

      const boxes = await containerBoxesById(page);
      expect(contains(boxes.get(vpcStack.id)!, boxes.get(bastionStack.id)!)).toBe(true);
    } finally {
      await page.close();
      cleanup();
    }
  }, 30_000);
});
