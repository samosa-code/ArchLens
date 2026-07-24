import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

/**
 * Loads every `.svg` file directly under `dir` into a `{serviceKey: dataUri}`
 * map, keyed by filename minus extension — `assets/icons/lambda.svg` becomes
 * `result['lambda']`, matching `RenderNode.service`'s own key vocabulary
 * exactly (Ticket 3.6.2). No separate icon-key map to keep in sync: whatever
 * file is present *is* the coverage, so a missing icon is never a silent
 * mismatch against some other list — it's just absent, and the caller falls
 * back to the existing text rendering.
 *
 * A `data:image/svg+xml;base64,...` URI, not a file path — required so the
 * bundled HTML stays one self-contained file with zero runtime fetches
 * (`build.test.ts`'s "zero network requests" acceptance criteria, which this
 * reuses rather than relaxes).
 */
export function loadIconDataUris(dir: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const filename of readdirSync(dir)) {
    if (extname(filename).toLowerCase() !== '.svg') continue;

    const contents = readFileSync(join(dir, filename), 'utf-8');
    if (!contents.trimStart().startsWith('<')) {
      throw new Error(`ArchLens: ${filename} is not valid SVG markup (expected it to start with '<')`);
    }

    const key = filename.slice(0, -extname(filename).length);
    result[key] = `data:image/svg+xml;base64,${Buffer.from(contents, 'utf-8').toString('base64')}`;
  }

  return result;
}
