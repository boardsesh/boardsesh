import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveWoodsImportDecision,
  assertWoodsImportAllowed,
  WOODS_IMPORT_ALLOW_REMOTE_ENV_VAR,
} from './woods-import-guard.js';

const LOCAL_URL = 'postgresql://postgres@localhost:5432/main';
const REMOTE_URL = 'postgres://boardsesh_readonly:pw@tramway.proxy.rlwy.net:45638/railway?sslmode=require';

/** Save/restore WOODS_IMPORT_ALLOW_REMOTE around a test that sets it. */
function withAllowRemoteEnv<T>(value: string | undefined, run: () => T): T {
  const original = process.env[WOODS_IMPORT_ALLOW_REMOTE_ENV_VAR];
  if (value === undefined) {
    delete process.env[WOODS_IMPORT_ALLOW_REMOTE_ENV_VAR];
  } else {
    process.env[WOODS_IMPORT_ALLOW_REMOTE_ENV_VAR] = value;
  }
  try {
    return run();
  } finally {
    if (original === undefined) {
      delete process.env[WOODS_IMPORT_ALLOW_REMOTE_ENV_VAR];
    } else {
      process.env[WOODS_IMPORT_ALLOW_REMOTE_ENV_VAR] = original;
    }
  }
}

void test('a local database is always allowed, regardless of the override', () => {
  assert.equal(resolveWoodsImportDecision(LOCAL_URL, undefined), 'local');
  assert.equal(resolveWoodsImportDecision(LOCAL_URL, '1'), 'local');
  assert.equal(resolveWoodsImportDecision(LOCAL_URL, 'true'), 'local');
});

// The override is a distinct env var from DB_URL, so pointing DB_URL at the
// wrong host never implicitly sets it — a DB_URL inherited from the shell
// (override undefined) is exactly this "refused by default" case.
void test('a remote database is refused by default', () => {
  assert.equal(resolveWoodsImportDecision(REMOTE_URL, undefined), 'remote-refused');
});

void test('a remote database is allowed only by the exact override value "1"', () => {
  assert.equal(resolveWoodsImportDecision(REMOTE_URL, '1'), 'remote-allowed');
});

void test('a remote database stays refused for any near-miss override value (fails closed)', () => {
  assert.equal(resolveWoodsImportDecision(REMOTE_URL, 'true'), 'remote-refused');
  assert.equal(resolveWoodsImportDecision(REMOTE_URL, 'yes'), 'remote-refused');
  assert.equal(resolveWoodsImportDecision(REMOTE_URL, ''), 'remote-refused');
  assert.equal(resolveWoodsImportDecision(REMOTE_URL, '01'), 'remote-refused');
});

// assertWoodsImportAllowed is the side-effecting wrapper around
// resolveWoodsImportDecision — it's what import-woods-catalog.ts actually
// calls, so its process.exit/console branches need direct coverage too, not
// just the pure decision function. process.exit is mocked to a no-op (never
// actually terminates the test process); console.error/warn are mocked to
// assert on their calls instead of printing during the test run.
void test('assertWoodsImportAllowed returns silently for a local database', (t) => {
  const exitMock = t.mock.method(process, 'exit', (() => undefined) as unknown as typeof process.exit);
  const errorMock = t.mock.method(console, 'error', () => undefined);
  const warnMock = t.mock.method(console, 'warn', () => undefined);

  assertWoodsImportAllowed(LOCAL_URL, 'test-script');

  assert.equal(exitMock.mock.calls.length, 0);
  assert.equal(errorMock.mock.calls.length, 0);
  assert.equal(warnMock.mock.calls.length, 0);
});

void test('assertWoodsImportAllowed warns but proceeds when the override is set', (t) => {
  const exitMock = t.mock.method(process, 'exit', (() => undefined) as unknown as typeof process.exit);
  const errorMock = t.mock.method(console, 'error', () => undefined);
  const warnMock = t.mock.method(console, 'warn', () => undefined);

  withAllowRemoteEnv('1', () => {
    assertWoodsImportAllowed(REMOTE_URL, 'test-script');
  });

  assert.equal(exitMock.mock.calls.length, 0);
  assert.equal(errorMock.mock.calls.length, 0);
  assert.equal(warnMock.mock.calls.length, 1);
  const [warningMessage] = warnMock.mock.calls[0].arguments;
  assert.match(String(warningMessage), /WOODS_IMPORT_ALLOW_REMOTE=1/);
  assert.match(String(warningMessage), /test-script/);
});

void test('assertWoodsImportAllowed errors and exits(1) when refused', (t) => {
  const exitMock = t.mock.method(process, 'exit', (() => undefined) as unknown as typeof process.exit);
  const errorMock = t.mock.method(console, 'error', () => undefined);
  const warnMock = t.mock.method(console, 'warn', () => undefined);

  withAllowRemoteEnv(undefined, () => {
    assertWoodsImportAllowed(REMOTE_URL, 'test-script');
  });

  assert.equal(warnMock.mock.calls.length, 0);
  assert.equal(exitMock.mock.calls.length, 1);
  assert.deepEqual(exitMock.mock.calls[0].arguments, [1]);
  assert.ok(errorMock.mock.calls.length > 0);
  const combinedErrorOutput = errorMock.mock.calls.map((call) => String(call.arguments[0])).join('\n');
  assert.match(combinedErrorOutput, /refuses to run against a non-local database/);
  assert.match(combinedErrorOutput, /test-script/);
  assert.match(combinedErrorOutput, /WOODS_IMPORT_ALLOW_REMOTE=1/);
});

// The refusal copy must not claim the importer is deprecated (the MoonBoard
// guard's wording) — this is the only Woods import path there is, and telling an
// operator to "use the other importer instead" would be a dead end.
void test('the refusal explains a deliberate prod import, not a deprecated script', (t) => {
  t.mock.method(process, 'exit', (() => undefined) as unknown as typeof process.exit);
  const errorMock = t.mock.method(console, 'error', () => undefined);
  t.mock.method(console, 'warn', () => undefined);

  withAllowRemoteEnv(undefined, () => {
    assertWoodsImportAllowed(REMOTE_URL, 'import-woods-catalog.ts');
  });

  const combinedErrorOutput = errorMock.mock.calls.map((call) => String(call.arguments[0])).join('\n');
  assert.doesNotMatch(combinedErrorOutput, /deprecated/i);
  assert.match(combinedErrorOutput, /deliberate/i);
});
