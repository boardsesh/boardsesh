import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_BYTES, allowlistEntryFor, evaluate, formatBytes } from './check-large-files.mjs';

const under = MAX_BYTES - 1;
const over = MAX_BYTES + 1;

void test('allowlistEntryFor matches allowlisted prefixes', () => {
  assert.ok(allowlistEntryFor('packages/moonboard-ocr/src/__tests__/fixtures/IMG_0958.PNG'));
  assert.ok(allowlistEntryFor('packages/mobile/modules/board-renderer/ios/x.a'));
  assert.ok(allowlistEntryFor('design/velvet-send-design-tokens-v1.png'));
});

void test('allowlistEntryFor returns undefined for non-allowlisted paths', () => {
  assert.equal(allowlistEntryFor('packages/web/public/huge.png'), undefined);
  assert.equal(allowlistEntryFor('docs/diagram.png'), undefined);
});

void test('evaluate ignores files at or under the threshold', () => {
  const { violations, allowedLarge } = evaluate([
    { filePath: 'packages/web/public/small.png', sizeBytes: under },
    { filePath: 'packages/web/public/exact.png', sizeBytes: MAX_BYTES },
  ]);
  assert.equal(violations.length, 0);
  assert.equal(allowedLarge.length, 0);
});

void test('evaluate flags an oversized non-allowlisted file', () => {
  const { violations } = evaluate([{ filePath: 'packages/web/public/huge.png', sizeBytes: over }]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].filePath, 'packages/web/public/huge.png');
});

void test('evaluate routes an oversized allowlisted file to allowedLarge, not violations', () => {
  const { violations, allowedLarge } = evaluate([
    { filePath: 'packages/moonboard-ocr/src/__tests__/fixtures/IMG_0958.PNG', sizeBytes: over },
  ]);
  assert.equal(violations.length, 0);
  assert.equal(allowedLarge.length, 1);
});

void test('evaluate sorts violations largest-first', () => {
  const { violations } = evaluate([
    { filePath: 'a.bin', sizeBytes: over },
    { filePath: 'b.bin', sizeBytes: over + 1_000_000 },
  ]);
  assert.deepEqual(
    violations.map((v) => v.filePath),
    ['b.bin', 'a.bin'],
  );
});

void test('formatBytes renders MB to two decimals', () => {
  assert.equal(formatBytes(2_000_000), '2.00 MB');
  assert.equal(formatBytes(3_100_000), '3.10 MB');
});
