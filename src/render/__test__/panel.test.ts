import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { buildHtml } from '../build.js';
import type { RenderGraph } from '../types.js';

/**
 * Ticket 3.3 — click-for-details side panel. Real browser, real click
 * events — the same pattern `render.test.ts` established for pan/zoom.
 * Assertions use plain `Locator` methods (`.textContent()`, `.count()`,
 * `.isHidden()`, `.evaluate()`), not `@playwright/test`'s extended
 * matchers (`toHaveText`, `toBeVisible`, ...) — this project's tests run
 * under `vitest`'s own `expect`, which doesn't have those registered
 * (confirmed directly: `render.test.ts` never uses them either).
 */

const GRAPH: RenderGraph = {
  nodes: [
    {
      id: 'fn', label: 'PutItemsFunction', type: 'AWS::Lambda::Function', service: 'lambda', layer: 'compute',
      file: 'template.yaml', line: 42, decisionReason: 'Classified as a component — a visible box on the diagram.',
      absorbed: [
        { nodeId: 'role', logicalId: 'LambdaExecutionRole', resourceType: 'AWS::IAM::Role', file: 'template.yaml', line: 78, group: 'permissions', reason: 'Absorbed into PutItemsFunction.', hasFinding: false },
        { nodeId: 'policy', logicalId: 'LambdaDynamoPolicy', resourceType: 'AWS::IAM::Policy', file: 'template.yaml', line: 91, group: 'permissions', reason: 'Absorbed into PutItemsFunction.', hasFinding: true },
        { nodeId: 'loggroup', logicalId: 'FunctionLogGroup', resourceType: 'AWS::Logs::LogGroup', file: 'template.yaml', line: 64, group: 'observability', reason: 'Absorbed into PutItemsFunction.', hasFinding: false },
      ],
      badges: [{ kind: 'security', message: 'LambdaDynamoPolicy grants dynamodb:* on all tables', sourceNodeId: 'policy' }],
    },
    { id: 'api', label: 'RestApi', type: 'AWS::ApiGateway::RestApi', service: 'apigateway', layer: 'api', file: 'template.yaml', line: 10, decisionReason: 'Classified as a component.', absorbed: [], badges: [] },
    { id: 'table', label: 'Users', type: 'AWS::DynamoDB::Table', service: 'dynamodb', layer: 'data', file: 'template.yaml', line: 5, decisionReason: 'Classified as a component.', absorbed: [], badges: [] },
  ],
  edges: [
    { source: 'api', target: 'fn', kind: 'invocation', label: 'routes to', delivery: 'sync', inferred: false },
    { source: 'fn', target: 'table', kind: 'dataAccess', label: 'reads/writes', delivery: 'sync', inferred: true },
  ],
};

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser.close();
}, 30_000);

describe('click-for-details side panel (Ticket 3.3)', () => {
  let tmpDir: string;
  let page: Page;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'archlens-panel-test-'));
    const outPath = join(tmpDir, 'index.html');
    writeFileSync(outPath, buildHtml(GRAPH), 'utf-8');
    page = await browser.newPage();
    await page.goto(pathToFileURL(outPath).href);
  });

  afterEach(async () => {
    await page.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('the panel is hidden until a node is clicked', async () => {
    expect(await page.locator('#archlens-panel').isHidden()).toBe(true);
  });

  test('clicking a node opens the panel with header info: label, type · layer, file:line', async () => {
    await page.locator('.archlens-node[data-node-id="fn"]').click();
    const panel = page.locator('#archlens-panel');
    expect(await panel.isHidden()).toBe(false);
    expect(await panel.locator('.archlens-panel-title').textContent()).toBe('PutItemsFunction');
    expect(await panel.locator('.archlens-panel-subtitle').textContent()).toBe('AWS::Lambda::Function · compute');
    expect(await panel.locator('.archlens-panel-source').textContent()).toContain('template.yaml:42');
  });

  test('collapsible sections are grouped and count-badged, absorbed-resource groups with nothing in them are omitted', async () => {
    await page.locator('.archlens-node[data-node-id="fn"]').click();
    const panel = page.locator('#archlens-panel');
    const permissions = panel.locator('.archlens-panel-section[data-group="permissions"]');
    expect(await permissions.locator('.archlens-panel-section-count').textContent()).toBe('2');
    expect(await permissions.locator('.archlens-panel-item').count()).toBe(2);

    const observability = panel.locator('.archlens-panel-section[data-group="observability"]');
    expect(await observability.locator('.archlens-panel-item').count()).toBe(1);

    // No absorbed resources at all in lifecycle/plumbing/networking — must not render an empty section.
    expect(await panel.locator('.archlens-panel-section[data-group="lifecycle"]').count()).toBe(0);
    expect(await panel.locator('.archlens-panel-section[data-group="plumbing"]').count()).toBe(0);
    expect(await panel.locator('.archlens-panel-section[data-group="networking"]').count()).toBe(0);
  });

  test('only the item a finding actually names gets the warning tint — not every item in its section (PO Question 24)', async () => {
    await page.locator('.archlens-node[data-node-id="fn"]').click();
    const panel = page.locator('#archlens-panel');
    const policyItem = panel.locator('.archlens-panel-item', { hasText: 'LambdaDynamoPolicy' });
    const roleItem = panel.locator('.archlens-panel-item', { hasText: 'LambdaExecutionRole' });
    expect(await policyItem.evaluate((el) => el.classList.contains('archlens-panel-item--finding'))).toBe(true);
    expect(await roleItem.evaluate((el) => el.classList.contains('archlens-panel-item--finding'))).toBe(false);
  });

  test('a security finding callout appears only when the node actually has one', async () => {
    await page.locator('.archlens-node[data-node-id="fn"]').click();
    expect(await page.locator('#archlens-panel .archlens-panel-findings').textContent()).toContain('LambdaDynamoPolicy grants dynamodb:* on all tables');

    await page.locator('.archlens-node[data-node-id="api"]').click();
    expect(await page.locator('#archlens-panel .archlens-panel-findings').isHidden()).toBe(true);
  });

  test('Connections section lists arch-level edges with role labels, not raw absorbed resources (PO Question 26)', async () => {
    await page.locator('.archlens-node[data-node-id="fn"]').click();
    const connectionsText = await page.locator('#archlens-panel .archlens-panel-connections').textContent();
    expect(connectionsText).toContain('routes to');
    expect(connectionsText).toContain('RestApi');
    expect(connectionsText).toContain('reads/writes');
    expect(connectionsText).toContain('Users');
    // Never the raw absorbed resource names in Connections.
    expect(connectionsText).not.toContain('LambdaExecutionRole');
  });

  test('clicking the close button hides the panel again', async () => {
    await page.locator('.archlens-node[data-node-id="fn"]').click();
    expect(await page.locator('#archlens-panel').isHidden()).toBe(false);
    await page.locator('#archlens-panel-close').click();
    expect(await page.locator('#archlens-panel').isHidden()).toBe(true);
  });

  test('clicking a different node replaces the panel content rather than stacking', async () => {
    await page.locator('.archlens-node[data-node-id="fn"]').click();
    await page.locator('.archlens-node[data-node-id="table"]').click();
    const panel = page.locator('#archlens-panel');
    expect(await panel.locator('.archlens-panel-title').textContent()).toBe('Users');
    expect(await panel.locator('.archlens-panel-title').count()).toBe(1);
  });
});
