import test from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { describeDatabaseHost, isLocalDatabaseUrl, scriptDatabaseConnectionOptions } from './db-connection.js';

// Real automation paths this must recognize as local, verified against the
// repo (see db-connection.ts's doc comment for the file:line evidence):
//   - Dockerfile.dev-db / setup-development-db.sh: postgresql://postgres@localhost/main
//   - docker-compose service name: postgresql://postgres:password@postgres:5432/main
//   - scripts/dev-db-discover.ts's Tailscale fallback: a MagicDNS *.ts.net name
//     or a 100.64.0.0/10 CGNAT address, used when local Docker isn't reachable.
void test('recognizes every real local/dev-tooling host shape as local', () => {
  assert.equal(isLocalDatabaseUrl('postgresql://postgres@localhost:5432/main'), true);
  assert.equal(isLocalDatabaseUrl('postgresql://postgres@127.0.0.1:5432/main'), true);
  assert.equal(isLocalDatabaseUrl('postgresql://postgres@[::1]:5432/main'), true);
  assert.equal(isLocalDatabaseUrl('postgresql://postgres:password@postgres:5432/main'), true);
  assert.equal(isLocalDatabaseUrl('postgresql://user:pass@foo.localtest.me:5432/db'), true);
  assert.equal(isLocalDatabaseUrl('postgresql://user:pass@localtest.me:5432/db'), true);
  assert.equal(isLocalDatabaseUrl('postgresql://user:pass@my-box.tailnet-name.ts.net:5432/db'), true);
  assert.equal(isLocalDatabaseUrl('postgresql://user:pass@100.64.0.1:5432/db'), true);
  assert.equal(isLocalDatabaseUrl('postgresql://user:pass@100.127.255.255:5432/db'), true);
});

void test('is case-insensitive on hostname', () => {
  assert.equal(isLocalDatabaseUrl('postgresql://postgres@LOCALHOST:5432/main'), true);
  assert.equal(isLocalDatabaseUrl('postgresql://user:pass@MY-BOX.TAILNET.TS.NET:5432/db'), true);
});

void test('refuses a real prod-shaped host (Railway proxy)', () => {
  assert.equal(
    isLocalDatabaseUrl('postgres://boardsesh_readonly:pw@tramway.proxy.rlwy.net:45638/railway?sslmode=require'),
    false,
  );
});

void test('refuses other plausible remote hosts', () => {
  assert.equal(isLocalDatabaseUrl('postgresql://user:pass@my-neon-project.neon.tech:5432/db'), false);
  assert.equal(isLocalDatabaseUrl('postgresql://user:pass@10.0.0.5:5432/db'), false);
  assert.equal(isLocalDatabaseUrl('postgresql://user:pass@192.168.1.20:5432/db'), false);
  assert.equal(isLocalDatabaseUrl('postgresql://user:pass@ts.net.attacker.example:5432/db'), false);
});

void test('rejects addresses just outside the Tailscale CGNAT range', () => {
  assert.equal(isLocalDatabaseUrl('postgresql://user:pass@100.63.255.255:5432/db'), false);
  assert.equal(isLocalDatabaseUrl('postgresql://user:pass@100.128.0.0:5432/db'), false);
});

void test('rejects octets that only look numeric to a loose parser (scientific notation, signs)', () => {
  // `Number('1e2')` is 100 — without a strict digit check, this would parse
  // as 100.100.0.1 and wrongly match the CGNAT range.
  assert.equal(isLocalDatabaseUrl('postgresql://user:pass@100.1e2.0.1:5432/db'), false);
  assert.equal(isLocalDatabaseUrl('postgresql://user:pass@+100.64.0.1:5432/db'), false);
});

void test('recognizes the whole 127.0.0.0/8 loopback block, not just 127.0.0.1', () => {
  // Linux commonly resolves the machine's own hostname to 127.0.1.1.
  assert.equal(isLocalDatabaseUrl('postgresql://user:pass@127.0.1.1:5432/db'), true);
  assert.equal(isLocalDatabaseUrl('postgresql://user:pass@127.0.0.2:5432/db'), true);
  assert.equal(isLocalDatabaseUrl('postgresql://user:pass@127.255.255.255:5432/db'), true);
});

void test('rejects addresses just outside the loopback block', () => {
  assert.equal(isLocalDatabaseUrl('postgresql://user:pass@126.255.255.255:5432/db'), false);
  assert.equal(isLocalDatabaseUrl('postgresql://user:pass@128.0.0.0:5432/db'), false);
});

void test('fails closed on malformed or empty URLs', () => {
  assert.equal(isLocalDatabaseUrl('not a url at all'), false);
  assert.equal(isLocalDatabaseUrl(''), false);
  assert.equal(isLocalDatabaseUrl('postgresql://'), false);
});

void test('forces TLS for remote scripts even when the URL requests plaintext', async () => {
  const plaintextUrl = 'postgresql://user:pass@direct.example:5432/db?sslmode=disable';
  const options = scriptDatabaseConnectionOptions(plaintextUrl);
  const client = postgres(plaintextUrl, options);
  assert.deepEqual(options, {
    max: 1,
    ssl: 'require',
  });
  assert.equal(client.options.ssl, 'require');
  await client.end();
  assert.deepEqual(scriptDatabaseConnectionOptions('postgresql://postgres@localhost:5432/main'), { max: 1 });
});

void test('preserves remote certificate verification instead of downgrading it', async () => {
  const verifiedUrl = 'postgresql://user:pass@direct.example:5432/db?sslmode=verify-full';
  const options = scriptDatabaseConnectionOptions(verifiedUrl);
  const client = postgres(verifiedUrl, options);
  assert.deepEqual(options, { max: 1 });
  assert.equal(client.options.ssl, 'verify-full');
  await client.end();
});

void test('matches postgres-js last-value and case-sensitive TLS parsing', async () => {
  const duplicateModeUrl = 'postgresql://user:pass@direct.example:5432/db?sslmode=verify-full&sslmode=disable';
  const duplicateModeClient = postgres(duplicateModeUrl, scriptDatabaseConnectionOptions(duplicateModeUrl));
  assert.equal(duplicateModeClient.options.ssl, 'require');
  await duplicateModeClient.end();

  const uppercaseRootUrl = 'postgresql://user:pass@direct.example:5432/db?sslmode=disable&sslrootcert=SYSTEM';
  const uppercaseRootClient = postgres(uppercaseRootUrl, scriptDatabaseConnectionOptions(uppercaseRootUrl));
  assert.equal(uppercaseRootClient.options.ssl, 'require');
  await uppercaseRootClient.end();

  const systemRootUrl = 'postgresql://user:pass@direct.example:5432/db?sslmode=disable&sslrootcert=system';
  const systemRootClient = postgres(systemRootUrl, scriptDatabaseConnectionOptions(systemRootUrl));
  assert.equal(systemRootClient.options.ssl, 'verify-full');
  await systemRootClient.end();
});

void test('describeDatabaseHost reports host:port for a normal connection string', () => {
  assert.equal(describeDatabaseHost('postgresql://postgres:password@localhost:5432/main'), 'localhost:5432');
  assert.equal(
    describeDatabaseHost('postgres://boardsesh_readonly:pw@tramway.proxy.rlwy.net:45638/railway?sslmode=require'),
    'tramway.proxy.rlwy.net:45638',
  );
});

void test('describeDatabaseHost is not confused by "@" or "/" inside the password', () => {
  // A naive `split('@')[1]?.split('/')[0]` would stop at the password's own
  // "@"/"/" and report a garbage or wrong host; new URL() handles encoding.
  assert.equal(
    describeDatabaseHost('postgresql://user:p%40ss%2Fword@realhost.example:5432/db'),
    'realhost.example:5432',
  );
});

void test('describeDatabaseHost fails closed to "unknown" on a malformed URL', () => {
  assert.equal(describeDatabaseHost('not a url at all'), 'unknown');
  assert.equal(describeDatabaseHost(''), 'unknown');
});
