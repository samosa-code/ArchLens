import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

/**
 * Ticket 3.4's own explicit testing requirement: run the CLI as a real
 * subprocess, assert the output file exists and is valid HTML.
 *
 * Runs the project's own real `tsc` build once in `beforeAll` and spawns
 * the resulting `dist/cli.js` directly — the same "npm run build && node
 * dist/....js" pattern every other demo script in this repo already
 * uses. Tried `esbuild`-bundling `cli.ts` into one self-contained file
 * first (matching `render/build.ts`'s own approach for `browser/app.ts`)
 * — that broke at runtime: `jsonc-parser`'s UMD module does a dynamic,
 * conditional `require('./impl/format')` esbuild can't statically resolve
 * when flattened into a single bundled file, so the bundle crashed with
 * `MODULE_NOT_FOUND` the instant JSON parsing was needed. The real
 * project build has no such problem (`node_modules` resolves normally
 * since `dist/cli.js` lives inside the project tree) — proven,
 * unglamorous, and it's exactly what `arch:demo`/`render:demo` already do.
 */

const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI_DIST_PATH = join(PROJECT_ROOT, 'dist', 'cli.js');
const EXAMPLES_DIR = join(PROJECT_ROOT, 'examples') + '\\';

beforeAll(() => {
  execSync('npx tsc --project tsconfig.build.json', { cwd: PROJECT_ROOT, stdio: 'pipe' });
}, 60_000);

function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync('node', [CLI_DIST_PATH, ...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { stdout, stderr: '', status: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; status?: number };
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', status: err.status ?? 1 };
  }
}

describe('archlens CLI — end to end (Ticket 3.4)', () => {
  let outDir: string;

  beforeAll(() => {
    outDir = mkdtempSync(join(tmpdir(), 'archlens-cli-out-'));
  });

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  test('running against a real fixture with --out produces a working index.html in the specified directory', () => {
    const pattern = join(EXAMPLES_DIR, '01-simple-lambda', 'template.yaml');
    const result = runCli([pattern, '--out', outDir]);

    expect(result.status).toBe(0);
    const outPath = join(outDir, 'index.html');
    expect(existsSync(outPath)).toBe(true);

    const html = readFileSync(outPath, 'utf-8');
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('<html');
    expect(html).not.toMatch(/<script[^>]+\bsrc=/i); // still one self-contained file, per Ticket 3.1's own AC
    expect(result.stdout).toContain('Wrote');
  });

  test('a sensible default output path is used when --out is omitted', () => {
    const localOutDir = mkdtempSync(join(tmpdir(), 'archlens-cli-default-out-'));
    try {
      const pattern = join(EXAMPLES_DIR, '01-simple-lambda', 'template.yaml');
      execFileSync('node', [CLI_DIST_PATH, pattern], { encoding: 'utf-8', cwd: localOutDir });

      const defaultOutPath = join(localOutDir, 'archlens-output', 'index.html');
      expect(existsSync(defaultOutPath)).toBe(true);
    } finally {
      rmSync(localOutDir, { recursive: true, force: true });
    }
  });

  test('--raw makes the IAM Role its own box; the default abstracted view absorbs it into the Function instead', () => {
    const pattern = join(EXAMPLES_DIR, '01-simple-lambda', 'template.yaml');

    const cookedDir = mkdtempSync(join(tmpdir(), 'archlens-cli-cooked-'));
    const rawDir = mkdtempSync(join(tmpdir(), 'archlens-cli-raw-'));
    try {
      runCli([pattern, '--out', cookedDir]);
      runCli([pattern, '--out', rawDir, '--raw']);

      const cookedHtml = readFileSync(join(cookedDir, 'index.html'), 'utf-8');
      const rawHtml = readFileSync(join(rawDir, 'index.html'), 'utf-8');

      // "LambdaRole" as a RenderNode's own `label` only exists in --raw
      // (a real top-level box). In the cooked view it survives only as an
      // absorbed item's `logicalId` inside the Function's `absorbed` array
      // — a real, precise distinguishing signal, not just string presence
      // (which would appear in both, since the cooked panel still needs
      // to list it). Note: esbuild's `define` re-prints the baked-in graph
      // as a JS object literal (unquoted keys, e.g. `label: "..."`), not
      // literal JSON text — confirmed directly against real output rather
      // than assumed.
      expect(rawHtml).toContain('label: "LambdaRole (IAM::Role)"'); // fromGraphModelRaw.ts's shortType() strips the "AWS::" prefix
      expect(cookedHtml).not.toMatch(/label:\s*"LambdaRole/);
      expect(cookedHtml).toContain('logicalId: "LambdaRole"');
    } finally {
      rmSync(cookedDir, { recursive: true, force: true });
      rmSync(rawDir, { recursive: true, force: true });
    }
  });

  test('--explain prints the abstraction report to stdout in addition to writing the HTML', () => {
    const pattern = join(EXAMPLES_DIR, '01-simple-lambda', 'template.yaml');
    const explainOutDir = mkdtempSync(join(tmpdir(), 'archlens-cli-explain-'));
    try {
      const result = runCli([pattern, '--out', explainOutDir, '--explain']);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('decisions');
      expect(existsSync(join(explainOutDir, 'index.html'))).toBe(true);
    } finally {
      rmSync(explainOutDir, { recursive: true, force: true });
    }
  });

  test('a pattern matching no files fails clearly rather than writing an empty diagram', () => {
    const result = runCli([join(EXAMPLES_DIR, 'no-such-directory', '*.yaml'), '--out', outDir]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('No template files matched');
  });

  test('an unrecognized flag fails clearly with a usage-relevant message', () => {
    const pattern = join(EXAMPLES_DIR, '01-simple-lambda', 'template.yaml');
    const result = runCli([pattern, '--not-a-real-flag']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--not-a-real-flag');
  });
});
