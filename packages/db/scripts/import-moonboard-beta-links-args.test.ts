import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBetaLinksCliArgs } from './import-moonboard-beta-links.js';

void test('a source path is read as the positional argument', () => {
  assert.deepEqual(parseBetaLinksCliArgs(['/tmp/beta.json']), { positional: ['/tmp/beta.json'], dryRun: false });
});

void test('--dry-run is recognised, with or without the `--` separator', () => {
  assert.equal(parseBetaLinksCliArgs(['/tmp/beta.json', '--dry-run']).dryRun, true);
  assert.deepEqual(parseBetaLinksCliArgs(['--', '--dry-run']), parseBetaLinksCliArgs(['--dry-run']));
});

void test('a typo that looks like --dry-run is rejected rather than ignored', () => {
  for (const typo of ['-dry-run', '--dryrun', '--dry']) {
    assert.throws(() => parseBetaLinksCliArgs([typo]), /Unknown flag/, `expected ${typo} to be rejected`);
  }
});
