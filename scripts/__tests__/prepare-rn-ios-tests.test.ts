/// <reference types="node" />

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const IOS_TESTS_DIR = resolve(REPO_ROOT, 'packages/mobile/ios-tests');
const PREPARE_SCRIPT = resolve(REPO_ROOT, 'scripts/prepare-rn-ios-tests.mjs');

describe('prepare-rn-ios-tests test target sources', () => {
  it('stages every tracked top-level Swift test source', () => {
    const prepareScript = readFileSync(PREPARE_SCRIPT, 'utf8');
    const trackedTestSources = readdirSync(IOS_TESTS_DIR)
      .filter((fileName) => fileName.endsWith('.swift'))
      .sort();

    for (const testSource of trackedTestSources) {
      expect(prepareScript, `${testSource} is missing from TEST_SOURCE_FILES`).toContain(
        `sourcePath: '../ios-tests/${testSource}'`,
      );
      expect(prepareScript, `${testSource} has no BoardseshTests project path`).toContain(
        `projectPath: 'BoardseshTests/${testSource}'`,
      );
    }
  });
});
