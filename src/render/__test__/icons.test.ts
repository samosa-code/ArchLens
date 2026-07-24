import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadIconDataUris } from '../icons.js';

describe('loadIconDataUris (Ticket 3.6.2)', () => {
  let tmpDir: string;

  function withTmpDir(fn: (dir: string) => void): void {
    tmpDir = mkdtempSync(join(tmpdir(), 'archlens-icons-test-'));
    try {
      fn(tmpDir);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  test('keys the result by filename (minus extension), matching RenderNode.service\'s own vocabulary', () => {
    withTmpDir((dir) => {
      writeFileSync(join(dir, 'lambda.svg'), '<svg><path d="M0 0"/></svg>', 'utf-8');
      writeFileSync(join(dir, 's3.svg'), '<svg><path d="M1 1"/></svg>', 'utf-8');

      const result = loadIconDataUris(dir);

      expect(Object.keys(result).sort()).toEqual(['lambda', 's3']);
    });
  });

  test('encodes each icon as a self-contained data: URI, never a path a browser would need to fetch', () => {
    withTmpDir((dir) => {
      writeFileSync(join(dir, 'lambda.svg'), '<svg><path d="M0 0"/></svg>', 'utf-8');

      const result = loadIconDataUris(dir);

      expect(result['lambda']).toMatch(/^data:image\/svg\+xml;base64,/);
      const [, base64] = result['lambda']!.split(',');
      expect(Buffer.from(base64!, 'base64').toString('utf-8')).toBe('<svg><path d="M0 0"/></svg>');
    });
  });

  test('ignores non-.svg files in the directory (e.g. a stray .DS_Store) rather than erroring on them', () => {
    withTmpDir((dir) => {
      writeFileSync(join(dir, 'lambda.svg'), '<svg><path d="M0 0"/></svg>', 'utf-8');
      writeFileSync(join(dir, '.DS_Store'), 'not svg at all', 'utf-8');

      const result = loadIconDataUris(dir);

      expect(Object.keys(result)).toEqual(['lambda']);
    });
  });

  test('throws a clear error — never silently produces a broken icon — when a .svg file is not actually valid SVG markup', () => {
    withTmpDir((dir) => {
      writeFileSync(join(dir, 'lambda.svg'), 'this is not svg markup', 'utf-8');

      expect(() => loadIconDataUris(dir)).toThrow(/lambda\.svg/);
    });
  });

  test('the real assets/icons directory this project ships loads without error and covers the expected service keys', () => {
    const result = loadIconDataUris(join(process.cwd(), 'assets/icons'));
    expect(Object.keys(result).length).toBeGreaterThanOrEqual(44);
    expect(result['lambda']).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(result['dynamodb']).toBeDefined();
    expect(result['s3']).toBeDefined();
  });
});
