import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { loadTemplates } from '../../parser/loader.js';
import { readFileAnnotations } from '../metadata.js';

/**
 * Ticket A.4 / PO Question 27: the `Metadata: ArchLens: {account, region}`
 * convention — the only signal that assigns a template to an
 * account/region boundary, read here from the loaded AST.
 */

const EXAMPLES_DIR = fileURLToPath(new URL('../../../examples/', import.meta.url));
const HUB = EXAMPLES_DIR + '15-multi-account-hub-spoke/hub-eventbus.yaml';
const SPOKE_EU = EXAMPLES_DIR + '15-multi-account-hub-spoke/spoke-app-eu.yaml';
const UNANNOTATED = EXAMPLES_DIR + '01-simple-lambda/template.yaml';

describe('readFileAnnotations', () => {
  test('reads account and region from the ArchLens metadata key, keyed by file', () => {
    const { templates } = loadTemplates([HUB, SPOKE_EU]);
    const annotations = readFileAnnotations(templates);

    expect(annotations.get(HUB)).toEqual({ account: 'Hub (111122223333)', region: 'us-east-1' });
    expect(annotations.get(SPOKE_EU)).toEqual({ account: 'Spoke (444455556666)', region: 'eu-west-1' });
  });

  test('a template without the ArchLens key gets no entry at all — absence, not an empty annotation', () => {
    const { templates } = loadTemplates([UNANNOTATED, HUB]);
    const annotations = readFileAnnotations(templates);

    expect(annotations.has(UNANNOTATED)).toBe(false);
    expect(annotations.size).toBe(1);
  });
});
