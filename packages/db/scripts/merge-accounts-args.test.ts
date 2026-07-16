import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from './merge-accounts.js';

test('no args is a dry-run (apply stays false)', () => {
  const parsed = parseArgs([]);
  assert.equal(parsed.apply, false);
  assert.equal(parsed.limit, null);
  assert.equal(parsed.onlyEmail, null);
  assert.equal(parsed.help, false);
});

test('--apply, --limit and --only-email parse; only-email is normalized', () => {
  const parsed = parseArgs(['--apply', '--limit', '5', '--only-email', '  Foo@X.com ']);
  assert.equal(parsed.apply, true);
  assert.equal(parsed.limit, 5);
  assert.equal(parsed.onlyEmail, 'foo@x.com');
});

test('a leading `--` separator is skipped, not treated as an unknown argument', () => {
  assert.deepEqual(parseArgs(['--', '--apply']), parseArgs(['--apply']));
});

test('--help sets help', () => {
  assert.equal(parseArgs(['--help']).help, true);
});

// The failure paths call process.exit(2). Stub it (and silence console.error)
// so the test can assert they bail instead of returning a bad ScriptArgs.
function assertExits(args: string[]): void {
  const originalExit = process.exit;
  const originalError = console.error;
  process.exit = ((): never => {
    throw new Error('process.exit');
  }) as typeof process.exit;
  console.error = () => {};
  try {
    assert.throws(() => parseArgs(args));
  } finally {
    process.exit = originalExit;
    console.error = originalError;
  }
}

test('an unknown flag exits', () => assertExits(['--nope']));
test('--limit 0 exits (requires a positive integer)', () => assertExits(['--limit', '0']));
test('--limit without a value exits', () => assertExits(['--limit']));
test('--only-email without a value exits', () => assertExits(['--only-email']));
