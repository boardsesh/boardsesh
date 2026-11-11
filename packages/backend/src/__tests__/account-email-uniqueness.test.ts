import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { IncomingMessage, type ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vite-plus/test';
import { createDbOnPool } from '@boardsesh/db/client';
import { users } from '@boardsesh/db/schema/auth';
import { normalizeAccountEmail } from '@boardsesh/auth-protocol/account-email';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { schemaSQL } from './schema-sql';
import { getWorkerDatabaseUrl } from './worker-db';

vi.mock('jose', async (importOriginal) => ({
  ...(await importOriginal<typeof import('jose')>()),
  createRemoteJWKSet: vi.fn(() => vi.fn()),
  jwtVerify: vi.fn(),
}));
const { jwtVerify } = await import('jose');
const { handleNativeAuthRegister, handleNativeAuthOAuth, __resetNativeAuthStateForTests } =
  await import('../handlers/native-auth');
// Separate, synthetic-only database: the shared BA-03 schema deliberately permits collisions.
const databaseUrl = new URL(getWorkerDatabaseUrl());
if (!['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname)) {
  throw new Error('Uniqueness tests require a loopback-only disposable database.');
}
databaseUrl.pathname += '_email_unique';
const adminUrl = new URL(databaseUrl);
adminUrl.pathname = '/postgres';
const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
const pool = postgres(databaseUrl.toString(), { max: 5, onnotice: () => {} });
const database = createDbOnPool(pool);
const journal = JSON.parse(
  readFileSync(new URL('../../../db/drizzle/meta/_journal.json', import.meta.url), 'utf8'),
) as { entries: { tag: string }[] };
const migrationTag = journal.entries.find((entry) => entry.tag.endsWith('_account_email_uniqueness'))!.tag;
const migration = readFileSync(new URL(`../../../db/drizzle/${migrationTag}.sql`, import.meta.url), 'utf8');

const normalizedConstraint = getTableConfig(users).checks.find(
  (constraint) => constraint.name === 'users_email_normalized',
);
if (!normalizedConstraint) throw new Error('Stored-email declaration is missing.');
const normalizedPredicate = normalizedConstraint.value;
const trimCases = [
  0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005,
  0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
].map((codePoint) => ({ label: codePoint.toString(16).padStart(4, '0'), padding: String.fromCodePoint(codePoint) }));

// Return only a fixed status, so failed normalization or mutation assertions do
// not print a database query, address or identifier into the test report.
async function databaseWriteStatus(operation: PromiseLike<unknown>): Promise<string> {
  try {
    await operation;
    return 'accepted';
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string')
      return error.code;
    return 'unclassified-error';
  }
}
async function declarationAccepts(specimen: string): Promise<boolean> {
  const [result] = await database.execute(
    sql`SELECT ${normalizedPredicate} AS accepted FROM (VALUES (${specimen})) AS "users"("email")`,
  );
  return result.accepted === true;
}

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE "${databaseUrl.pathname.slice(1)}"`);
  await pool.unsafe(schemaSQL);
  await pool`INSERT INTO users (id,email) VALUES ('synthetic-existing', 'Existing@fixture.example.test')`;
  await pool.begin(async (transaction) => {
    await transaction.unsafe(migration);
  });
});
afterAll(async () => {
  await pool.end();
  await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseUrl.pathname.slice(1)}"`);
  await admin.end();
});
beforeEach(() => {
  __resetNativeAuthStateForTests();
  vi.mocked(jwtVerify).mockReset();
});

async function call(kind: 'password' | 'provider', email: string) {
  const request = new IncomingMessage(new Socket());
  request.method = 'POST';
  request.headers = {};
  let status = 0;
  const response = {
    writeHead(code: number) {
      status = code;
    },
    setHeader() {},
    end() {},
  };
  const body =
    kind === 'password'
      ? { email, password: 'synthetic-password' }
      : { provider: 'apple', identityToken: 'synthetic-token' };
  if (kind === 'provider')
    vi.mocked(jwtVerify).mockResolvedValueOnce({
      payload: { sub: randomUUID(), email, email_verified: true },
      protectedHeader: { alg: 'RS256' },
    } as Awaited<ReturnType<typeof jwtVerify>>);
  try {
    const handling = (kind === 'password' ? handleNativeAuthRegister : handleNativeAuthOAuth)(
      request,
      response as unknown as ServerResponse,
      database,
    );
    request.emit('data', Buffer.from(JSON.stringify(body)));
    request.emit('end');
    await handling;
    return status;
  } finally {
    request.destroy();
  }
}

// A held users table lock forces BOTH requests past their pre-check before either inserts.
async function race(first: 'password' | 'provider', second: 'password' | 'provider') {
  const email = `race-${randomUUID()}@fixture.example.test`;
  let release = () => {};
  let locked = () => {};
  const mayCommit = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hasLock = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const holder = pool.begin(async (transaction) => {
    await transaction`LOCK TABLE users IN SHARE MODE`;
    locked();
    await mayCommit;
  });
  let replies: Promise<number[]> | undefined;
  try {
    await hasLock;
    replies = Promise.all([call(first, email.toUpperCase()), call(second, email)]);
    const deadline = Date.now() + 8000;
    for (;;) {
      const [row] =
        await pool`SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`;
      if (row.waiting >= 2) break;
      if (Date.now() > deadline) throw new Error('Both writers did not reach the insert barrier');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    release();
    await holder;
    const statuses = await replies;
    expect(statuses.filter((status) => status === 409)).toHaveLength(1);
    expect(statuses.filter((status) => status === 200 || status === 201)).toHaveLength(1);
    const [counts] =
      await pool`SELECT count(*)::int AS users, (SELECT count(*)::int FROM user_credentials WHERE user_id IN (SELECT id FROM users WHERE lower(email) = ${email})) AS credentials, (SELECT count(*)::int FROM accounts WHERE "userId" IN (SELECT id FROM users WHERE lower(email) = ${email})) AS providers FROM users WHERE lower(email) = ${email}`;
    expect(counts.users).toBe(1);
    expect(counts.credentials + counts.providers).toBe(1);
    const [orphans] =
      await pool`SELECT (SELECT count(*) FROM user_credentials credential LEFT JOIN users ON users.id = credential.user_id WHERE users.id IS NULL) + (SELECT count(*) FROM accounts account LEFT JOIN users ON users.id = account."userId" WHERE users.id IS NULL) AS count`;
    expect(Number(orphans.count)).toBe(0);
  } finally {
    release();
    await Promise.allSettled([holder, ...(replies ? [replies] : [])]);
  }
}

it('two mixed-case password registrations return success and 409 without partial identities', async () => {
  await race('password', 'password');
});
it('password versus verified provider returns success and 409 without partial identities', async () => {
  await race('password', 'provider');
});
it('two first-time providers return success and 409 without partial identities', async () => {
  await race('provider', 'provider');
});
it('keeps old mixed-case fixtures while rejecting new non-normalized writes', async () => {
  expect(await pool`SELECT id FROM users WHERE id = 'synthetic-existing'`).toHaveLength(1);
  const [constraint] =
    await pool`SELECT convalidated FROM pg_constraint WHERE conrelid = 'users'::regclass AND conname = 'users_email_normalized'`;
  expect(constraint.convalidated).toBe(false);
  await expect(
    pool`INSERT INTO users (id,email) VALUES ('synthetic-rejected','NEW@fixture.example.test')`,
  ).rejects.toMatchObject({ code: '23514' });
  await expect(
    pool`INSERT INTO users (id,email) VALUES ('synthetic-spaced',' spaced@fixture.example.test ')`,
  ).rejects.toMatchObject({ code: '23514' });
});
it.each(trimCases)('both declaration and DDL reject U+$label padding on insert and update', async ({ padding }) => {
  const ownerId = randomUUID();
  const canonical = `identity-${randomUUID()}`;
  const padded = padding + canonical + padding;
  expect(normalizeAccountEmail(padded) === canonical).toBe(true);
  expect(await declarationAccepts(padded)).toBe(false);
  expect(await databaseWriteStatus(pool`INSERT INTO users (id,email) VALUES (${ownerId}, ${padded})`)).toBe('23514');
  expect(await declarationAccepts(canonical)).toBe(true);
  expect(await databaseWriteStatus(pool`INSERT INTO users (id,email) VALUES (${ownerId}, ${canonical})`)).toBe(
    'accepted',
  );
  expect(await databaseWriteStatus(pool`UPDATE users SET email = ${padded} WHERE id = ${ownerId}`)).toBe('23514');
  const [stored] = await pool`SELECT email FROM users WHERE id = ${ownerId}`;
  expect(stored.email === canonical).toBe(true);
});

it('preserves non-trim code points and internal whitespace exactly as JS does', async () => {
  const specimens = [0x0085, 0x200b, 0x2060].map(
    (codePoint) => String.fromCodePoint(codePoint) + `identity-${randomUUID()}` + String.fromCodePoint(codePoint),
  );
  specimens.push(`inside\tidentity-${randomUUID()}`);
  for (const specimen of specimens) {
    expect(normalizeAccountEmail(specimen) === specimen).toBe(true);
    expect(await declarationAccepts(specimen)).toBe(true);
    expect(await databaseWriteStatus(pool`INSERT INTO users (id,email) VALUES (${randomUUID()}, ${specimen})`)).toBe(
      'accepted',
    );
  }
});

it('uses the expression index and replay only holds SHARE on users', async () => {
  await pool.begin(async (transaction) => {
    await transaction`INSERT INTO users (id, email) SELECT 'synthetic-plan-' || entry, 'plan-' || entry || '@fixture.example.test' FROM generate_series(1, 4000) entry`;
    await transaction`ANALYZE users`;
    const plan = await transaction`EXPLAIN SELECT id FROM users WHERE lower(email) = 'nobody@fixture.example.test'`;
    expect(JSON.stringify(plan)).toContain('users_email_lower_key');
    await transaction.unsafe(migration);
    const locks =
      await transaction`SELECT mode FROM pg_locks WHERE pid = pg_backend_pid() AND relation = 'users'::regclass`;
    expect(locks.map((lock) => lock.mode)).toContain('ShareLock');
    expect(locks.map((lock) => lock.mode)).not.toContain('AccessExclusiveLock');
  });
});
