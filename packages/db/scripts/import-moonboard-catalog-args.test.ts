import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCatalogCliArgs } from './import-moonboard-catalog.js';

// This importer writes to production. Every case below exists so a mistyped
// invocation fails loudly instead of quietly doing the wrong import.

void test('no arguments is a real (non-dry) run of the default directory', () => {
  const parsed = parseCatalogCliArgs([]);
  assert.deepEqual(parsed, { positional: [], holdsetup: undefined, dryRun: false });
});

void test('a catalog directory is read as the positional argument', () => {
  assert.deepEqual(parseCatalogCliArgs(['/tmp/app-catalog']).positional, ['/tmp/app-catalog']);
});

void test('--dry-run is recognised', () => {
  assert.equal(parseCatalogCliArgs(['/tmp/app-catalog', '--dry-run']).dryRun, true);
});

void test('a leading `--` separator is skipped, not treated as an unknown flag', () => {
  // `vp run '@boardsesh/db#db:import-moonboard-catalog' -- --dry-run` forwards
  // the separator verbatim.
  assert.deepEqual(parseCatalogCliArgs(['--', '--dry-run']), parseCatalogCliArgs(['--dry-run']));
});

void test('--holdsetup consumes its value instead of leaving it as the catalog directory', () => {
  // The bug this guards: a naive "first non-flag argument is the path" reads
  // the 21 in `--holdsetup 21` as a directory and imports from ./21.
  const parsed = parseCatalogCliArgs(['--holdsetup', '21']);
  assert.equal(parsed.holdsetup, 21);
  assert.deepEqual(parsed.positional, []);
});

void test('--holdsetup still works after a positional directory', () => {
  const parsed = parseCatalogCliArgs(['/tmp/app-catalog', '--holdsetup', '15', '--dry-run']);
  assert.equal(parsed.holdsetup, 15);
  assert.equal(parsed.dryRun, true);
  assert.deepEqual(parsed.positional, ['/tmp/app-catalog']);
});

void test('a typo that looks like --dry-run is rejected rather than ignored', () => {
  // The whole reason the parser fails closed: silently ignoring any of these
  // would commit a rehearsal straight to production.
  for (const typo of ['-dry-run', '--dryrun', '--dry_run', '--dry']) {
    assert.throws(() => parseCatalogCliArgs([typo]), /Unknown flag/, `expected ${typo} to be rejected`);
  }
});

void test('--holdsetup without a value is rejected', () => {
  assert.throws(() => parseCatalogCliArgs(['--holdsetup']), /needs a value/);
});

void test('a non-integer --holdsetup is rejected', () => {
  assert.throws(() => parseCatalogCliArgs(['--holdsetup', 'kilter']), /needs an integer/);
  assert.throws(() => parseCatalogCliArgs(['--holdsetup', '1.5']), /needs an integer/);
});
