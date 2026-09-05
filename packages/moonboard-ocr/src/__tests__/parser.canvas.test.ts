// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

/**
 * Canvas-based parser tests.
 *
 * These tests validate the Canvas (Browser) implementation of the parser.
 * Uses node-canvas to simulate browser Canvas API in Node.js.
 * Uses shared expected results from fixtures/expected-results.ts.
 *
 * NOTE: OCR results may vary slightly between Sharp and node-canvas due to
 * different image processing pipelines. Hold detection should be consistent.
 */

import { describe, it, beforeAll, afterAll } from 'vite-plus/test';
import path from 'path';
import { createScheduler, createWorker } from 'tesseract.js';
import { NodeCanvasImageProcessor } from './helpers/node-canvas-processor';
import { parseWithProcessor } from '../parser';
import { EXPECTED_RESULTS } from './fixtures/expected-results';
import { validateParseResult } from './helpers/test-utils';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

type Scheduler = Awaited<ReturnType<typeof createScheduler>>;

describe('MoonBoard OCR Parser (Canvas Implementation)', () => {
  let scheduler: Scheduler;

  beforeAll(async () => {
    scheduler = createScheduler();
    const workerCount = 4;
    const workers = await Promise.all(Array.from({ length: workerCount }, () => createWorker('eng')));
    for (const w of workers) scheduler.addWorker(w);
  }, 60_000);

  afterAll(async () => {
    await scheduler.terminate();
  });

  for (const expected of EXPECTED_RESULTS) {
    describe(expected.fixture, () => {
      it.concurrent('should extract correct climb data', async () => {
        const processor = new NodeCanvasImageProcessor();
        await processor.load(path.join(FIXTURES_DIR, expected.fixture));
        const result = await parseWithProcessor(processor, { scheduler });

        validateParseResult(result, expected, {
          validateOcr: true,
          partialNameMatch: true, // Use partial match due to OCR variations
        });
      });
    });
  }
});
