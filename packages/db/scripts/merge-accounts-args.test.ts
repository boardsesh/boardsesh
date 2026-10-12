import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertAllUserFksHandled, parseArgs } from './merge-accounts.js';

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

test('current unhandled ownership, privacy and consent foreign keys reject account merging', async () => {
  const unhandledColumns = [
    'board_climb_revisions.edited_by',
    'content_privacy.owner_id',
    'notification_deliveries.recipient_id',
    'notification_devices.user_id',
    'resource_grants.invited_by',
    'resource_grants.user_id',
    'resource_privacy.owner_id',
    'user_activity_days.user_id',
    'user_analytics_consent_events.user_id',
    'user_follow_requests.recipient_id',
    'user_follow_requests.requester_id',
  ];
  let queryCount = 0;
  const commandDb = {
    execute: async () => {
      queryCount += 1;
      return unhandledColumns.map((qualifiedColumn) => {
        const [childTable, childColumn] = qualifiedColumn.split('.');
        return { childTable, childColumn };
      });
    },
  };

  await assert.rejects(assertAllUserFksHandled(commandDb), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /11 foreign key\(s\).*not handled/);
    for (const qualifiedColumn of unhandledColumns) {
      assert.ok(error.message.includes(qualifiedColumn));
    }
    return true;
  });
  assert.equal(queryCount, 1, 'only the catalog audit runs; no merge queries execute');
});
