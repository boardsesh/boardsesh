/**
 * Sharp-based parser tests.
 *
 * These tests validate the Sharp (Node.js) implementation of the parser.
 * Uses shared expected results from fixtures/expected-results.ts.
 */

import { describe, it, expect } from 'vite-plus/test';
import path from 'path';
import { SharpImageProcessor } from '../image-processor/sharp-processor';
import { parseWithProcessor } from '../parser-core';
import { parseScreenshot } from '../parser';
import { EXPECTED_RESULTS } from './fixtures/expected-results';
import { useTesseractScheduler, validateParseResult } from './helpers/test-utils';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

describe('MoonBoard OCR Parser (Sharp Implementation)', () => {
  const scheduler = useTesseractScheduler();

  for (const expected of EXPECTED_RESULTS) {
    describe(expected.fixture, () => {
      it.concurrent('should extract correct climb data', async () => {
        const processor = new SharpImageProcessor();
        await processor.load(path.join(FIXTURES_DIR, expected.fixture));
        const result = await parseWithProcessor(processor, { scheduler: scheduler.current() });

        validateParseResult(result, expected, {
          validateOcr: true,
          partialNameMatch: true, // Use partial match for multi-line names
        });
      });
    });
  }

  // Smoke-test the public `parseScreenshot(path)` wrapper. The per-fixture
  // tests above drive `parseWithProcessor` directly for speed (shared scheduler);
  // this one-off check guards the thin file-path API that callers actually use.
  it('parseScreenshot wires a Sharp processor end-to-end', async () => {
    const expected = EXPECTED_RESULTS[0];
    const result = await parseScreenshot(path.join(FIXTURES_DIR, expected.fixture), { scheduler: scheduler.current() });
    expect(result.success).toBe(true);
    expect(result.climb).toBeDefined();
    expect(result.climb!.sourceFile).toBe(expected.fixture);
  });
});
