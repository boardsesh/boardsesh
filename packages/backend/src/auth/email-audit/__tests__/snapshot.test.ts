import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { accounts, userCredentials, users } from '@boardsesh/db/schema/auth';
import { getWorkerDatabaseUrl } from '../../../__tests__/worker-db';
import { auditAccountEmailSnapshot } from '../snapshot';
import { EMAIL_AUDIT_LIMITS, EmailAuditError } from '../report';
import { hydrateAccountsFixtureSchema } from './fixtures/accounts-schema';
import {
  emailAuditConnectionOptions,
  parseEmailAuditArguments,
  runEmailAudit,
  writeEmailAuditDetails,
} from '../../../scripts/audit-account-emails';

const checkoutRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const fixtureDirectory = mkdtempSync(join(tmpdir(), 'boardsesh-email-audit-'));
const fixtureSuffix = randomUUID();
const firstId = `audit-a-${fixtureSuffix}`;
const secondId = `audit-b-${fixtureSuffix}`;
const emptyId = `audit-empty-${fixtureSuffix}`;
const collisionEmail = `Audit.${fixtureSuffix}+test@example.test`;
const secretCanary = `fixture-only-never-read-${fixtureSuffix}`;
let writer: postgres.Sql;
let reader: postgres.Sql;
const queries: string[] = [];

async function invokeCli(arguments_: string[], environment: NodeJS.ProcessEnv) {
  const child = spawn('vp', ['exec', 'tsx', 'packages/backend/src/scripts/audit-account-emails.ts', ...arguments_], {
    cwd: checkoutRoot,
    env: environment,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const group = child.pid;
  let stdout = '';
  let stderr = '';
  let capturedBytes = 0;
  type StopReason =
    | 'deadline'
    | 'output-limit'
    | 'spawn-error'
    | 'descendants-after-close'
    | 'group-inspection'
    | 'parent-signal';
  let stopReason: StopReason | null = null;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const signalGroup = (signal: NodeJS.Signals) => {
    if (group === undefined || !Number.isSafeInteger(group) || group <= 1 || group === process.pid) return;
    try {
      process.kill(-group, signal);
    } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH'))
        stopReason ??= 'group-inspection';
    }
  };
  const liveGroup = () => {
    if (group === undefined || !Number.isSafeInteger(group) || group <= 1) return false;
    const processes = execFileSync('ps', ['-eo', 'pgid=,stat='], {
      env: { PATH: '/usr/bin:/bin', LANG: 'C', NODE_ENV: 'test' },
      encoding: 'utf8',
      timeout: 1000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return processes.split('\n').some((line) => {
      const [processGroup, state] = line.trim().split(/\s+/);
      return Number(processGroup) === group && !state?.startsWith('Z');
    });
  };
  const stop = (reason: StopReason) => {
    if (stopReason !== null) return;
    stopReason = reason;
    signalGroup('SIGTERM');
    escalation = setTimeout(() => signalGroup('SIGKILL'), 2000);
  };
  const capture = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
    capturedBytes += chunk.length;
    if (capturedBytes > 65536) {
      stop('output-limit');
      return;
    }
    if (stream === 'stdout') stdout += chunk.toString('utf8');
    else stderr += chunk.toString('utf8');
  };
  child.stdout.on('data', (chunk: Buffer) => capture(chunk, 'stdout'));
  child.stderr.on('data', (chunk: Buffer) => capture(chunk, 'stderr'));
  child.once('error', () => stop('spawn-error'));
  // The child has its own group. An outer QA stop must not leave that group
  // behind when it terminates this worker before the normal deadline fires.
  const stopForParentSignal = () => {
    stopReason ??= 'parent-signal';
    signalGroup('SIGKILL');
  };
  const stopAtParentExit = () => signalGroup('SIGKILL');
  process.prependListener('SIGINT', stopForParentSignal);
  process.prependListener('SIGTERM', stopForParentSignal);
  process.once('exit', stopAtParentExit);
  const deadline = setTimeout(() => stop('deadline'), 20000);
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveChild) => {
    child.once('close', (code, signal) => resolveChild({ code, signal }));
  });
  clearTimeout(deadline);
  let groupDrained = false;
  try {
    if (liveGroup()) {
      stop('descendants-after-close');
      const drainDeadline = performance.now() + 4000;
      while (liveGroup() && performance.now() < drainDeadline)
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    groupDrained = !liveGroup();
  } catch {
    stopReason ??= 'group-inspection';
  } finally {
    if (!groupDrained) signalGroup('SIGKILL');
    clearTimeout(escalation);
    process.removeListener('SIGINT', stopForParentSignal);
    process.removeListener('SIGTERM', stopForParentSignal);
    process.removeListener('exit', stopAtParentExit);
  }
  if (stopReason !== null || !groupDrained || outcome.signal !== null)
    throw new Error('Owned email-audit CLI fixture did not close cleanly.');
  return { code: outcome.code, stdout, stderr, childCloseObserved: true, groupDrained };
}

describe.sequential('actual read-only account email snapshot and CLI', () => {
  beforeAll(async () => {
    writer = postgres(getWorkerDatabaseUrl(), { max: 1, onnotice: () => {} });
    reader = postgres(getWorkerDatabaseUrl(), {
      max: 1,
      onnotice: () => {},
      debug: (_connection, query) => {
        queries.push(query);
      },
    });
    await hydrateAccountsFixtureSchema(writer);
    const database = drizzle(writer);
    await database.insert(users).values([
      { id: firstId, email: collisionEmail, emailVerified: new Date('2020-01-02T03:04:05Z') },
      { id: secondId, email: `  ${collisionEmail.toLowerCase()}\u00a0` },
      { id: emptyId, email: '\u2003' },
    ]);
    await database.insert(userCredentials).values({ userId: firstId, passwordHash: secretCanary });
    await database.insert(accounts).values({
      userId: secondId,
      type: 'oauth',
      provider: 'audit-fixture',
      providerAccountId: fixtureSuffix,
      access_token: secretCanary,
      refresh_token: secretCanary,
      id_token: secretCanary,
    });
  });
  afterAll(async () => {
    const closed = await Promise.allSettled([reader?.end({ timeout: 5 }), writer?.end({ timeout: 5 })]);
    if (closed.some((outcome) => outcome.status === 'rejected')) throw new Error('Audit fixture cleanup failed');
  });

  it('reads a complete public snapshot without credential or provider secret columns', async () => {
    // Deliberately shadow users on this exact connection. Qualified reads must
    // still use public.users, which has email and verification columns.
    await reader.unsafe('CREATE TEMP TABLE users (id text PRIMARY KEY)');
    queries.length = 0;
    const report = await auditAccountEmailSnapshot(reader, { pageSize: 1 });
    expect(report.snapshot).toMatchObject({
      readOnly: true,
      isolation: 'repeatable read',
      reachedEof: true,
      countReconciled: true,
    });
    expect(report.snapshot.targetFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(report.counts.totalUsers).toBeGreaterThanOrEqual(3);
    const collision = report.groups.find((group) => group.normalizedEmail === collisionEmail.toLowerCase());
    expect(collision?.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: firstId,
          emailVerified: '2020-01-02T03:04:05.000Z',
          hasPassword: true,
          linkedProviderCount: 0,
        }),
        expect.objectContaining({ userId: secondId, hasPassword: false, linkedProviderCount: 1 }),
      ]),
    );
    expect(JSON.stringify(report)).not.toContain(secretCanary);
    expect(queries.join('\n')).not.toMatch(/password_hash|access_token|refresh_token|id_token|providerAccountId/);
  });

  it('keeps EOF, counts and values on one snapshot during a concurrent committed write', async () => {
    let committed = false;
    const newId = `audit-concurrent-${fixtureSuffix}`;
    const report = await auditAccountEmailSnapshot(reader, {
      pageSize: 1,
      onPage: async () => {
        if (committed) return;
        const database = drizzle(writer);
        await database.insert(users).values({ id: newId, email: `new-${fixtureSuffix}@example.test` });
        await database
          .update(users)
          .set({ email: `changed-${fixtureSuffix}@example.test` })
          .where(eq(users.id, firstId));
        committed = true;
      },
    });
    expect(committed).toBe(true);
    expect(report.groups.find((group) => group.normalizedEmail === collisionEmail.toLowerCase())?.members).toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: firstId, email: collisionEmail })]),
    );
    const after = await auditAccountEmailSnapshot(reader, { pageSize: 1 });
    expect(after.counts.totalUsers).toBe(report.counts.totalUsers + 1);
    expect(after.groups.some((group) => group.members.some((member) => member.userId === firstId))).toBe(false);
  });

  it('pins aggregate lookup despite a preceding session search-path schema', async () => {
    const shadowSchema = `email_audit_shadow_${randomUUID().replaceAll('-', '')}`;
    await reader.unsafe(`CREATE SCHEMA "${shadowSchema}"`);
    await reader.unsafe(
      `CREATE FUNCTION "${shadowSchema}".zero_count(bigint) RETURNS bigint LANGUAGE SQL IMMUTABLE AS 'SELECT 0::bigint'`,
    );
    await reader.unsafe(
      `CREATE AGGREGATE "${shadowSchema}".count(*) (SFUNC = "${shadowSchema}".zero_count, STYPE = bigint, INITCOND = '0')`,
    );
    await reader.unsafe(`SET search_path = "${shadowSchema}", pg_catalog`);
    try {
      const [shadowed] = await reader<{ total: string }[]>`SELECT count(*) AS total FROM "public"."users"`;
      expect(Number(shadowed?.total)).toBe(0);
      const report = await auditAccountEmailSnapshot(reader);
      expect(report.counts.totalUsers).toBeGreaterThanOrEqual(4);
      expect(report.counts.providerLinks).toBeGreaterThanOrEqual(1);
    } finally {
      await reader.unsafe('RESET search_path');
    }
  });

  it('rejects row, byte and elapsed caps instead of returning partial counts', async () => {
    await expect(auditAccountEmailSnapshot(reader, { maxUsers: 1 })).rejects.toMatchObject({ code: 'INPUT_LIMIT' });
    await expect(auditAccountEmailSnapshot(reader, { maxTextBytes: 1 })).rejects.toMatchObject({ code: 'INPUT_LIMIT' });
    await expect(
      auditAccountEmailSnapshot(reader, {
        maximumMs: 1,
        onPage: async () => {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
        },
      }),
    ).rejects.toMatchObject({ code: 'TIME_LIMIT' });
  });

  it('observes a real lock wait, returns timeout and verifies server cleanup before releasing the blocker', async () => {
    await writer.begin(async (locker) => {
      await locker.unsafe('LOCK TABLE "public"."users" IN ACCESS EXCLUSIVE MODE');
      const [owner] = await locker<{ pid: number }[]>`SELECT pg_catalog.pg_backend_pid() AS pid`;
      const lockerPid = owner?.pid;
      if (typeof lockerPid !== 'number' || !Number.isSafeInteger(lockerPid))
        throw new Error('Expected the fixture lock owner.');
      const maximumMs = 750;
      const started = performance.now();
      let summary: unknown;
      let failure: unknown;
      let settled = false;
      let observedLockAt: number | null = null;
      // Both branches are attached immediately: rejection remains handled while
      // the locker observes the separate audit connection waiting on its PID.
      const settlement = runEmailAudit(
        { maximumMs },
        { ACCOUNT_EMAIL_AUDIT_DATABASE_URL: getWorkerDatabaseUrl(), DEBUG_SQL: 'false' },
      )
        .then(
          (result) => {
            summary = result;
          },
          (error: unknown) => {
            failure = error;
          },
        )
        .finally(() => {
          settled = true;
        });
      try {
        while (!settled && performance.now() - started < maximumMs) {
          await locker`SELECT pg_catalog.pg_stat_clear_snapshot()`;
          const [activity] = await locker<{ blocked: number }[]>`SELECT pg_catalog.count(*)::integer AS blocked
            FROM pg_catalog.pg_stat_activity WHERE datname = pg_catalog.current_database()
            AND application_name = 'boardsesh_account_email_audit' AND wait_event_type = 'Lock'
            AND ${lockerPid} = ANY(pg_catalog.pg_blocking_pids(pid))`;
          if ((activity?.blocked ?? 0) > 0) {
            observedLockAt = performance.now();
            break;
          }
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
        }
        await settlement;
        expect(observedLockAt).not.toBeNull();
        expect((observedLockAt ?? Number.POSITIVE_INFINITY) - started).toBeLessThan(maximumMs);
        expect(failure).toBeInstanceOf(EmailAuditError);
        expect(failure).toMatchObject({ code: 'TIME_LIMIT' });
        expect(summary).toBeUndefined();

        let remaining = -1;
        while (performance.now() - started < 7000) {
          await locker`SELECT pg_catalog.pg_stat_clear_snapshot()`;
          const [activity] = await locker<{ remaining: number }[]>`SELECT pg_catalog.count(*)::integer AS remaining
            FROM pg_catalog.pg_stat_activity WHERE datname = pg_catalog.current_database()
            AND application_name = 'boardsesh_account_email_audit'`;
          remaining = activity?.remaining ?? -1;
          if (remaining === 0) break;
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
        }
        // The real server can outlive end()'s timeout. The blocker remains held
        // through this bounded disappearance check; it cannot manufacture EOF.
        expect(remaining).toBe(0);
        expect(performance.now() - started).toBeLessThan(7000);
      } finally {
        // Even an observation/assertion failure must not abandon the owned
        // asynchronous operation before releasing its blocking transaction.
        await settlement;
      }
    });
  }, 12000);

  it('runs the actual CLI and binds exclusively created private details after cleanup', async () => {
    const detailsFile = join(fixtureDirectory, 'details.json');
    const result = await invokeCli(['--details-file', detailsFile], {
      ...process.env,
      ACCOUNT_EMAIL_AUDIT_DATABASE_URL: getWorkerDatabaseUrl(),
      DEBUG_SQL: 'false',
    });
    expect(result.code).toBe(0);
    const summary = JSON.parse(result.stdout);
    expect(summary).toMatchObject({
      status: 'complete',
      connectionClosed: true,
      snapshot: { reachedEof: true, countReconciled: true },
    });
    expect(result.childCloseObserved).toBe(true);
    expect(result.groupDrained).toBe(true);
    const detailBytes = readFileSync(detailsFile);
    expect(summary.detail.sha256).toBe(createHash('sha256').update(detailBytes).digest('hex'));
    expect(summary.detail.bytes).toBe(detailBytes.length);
    const detail = JSON.parse(detailBytes.toString('utf8'));
    expect(detail).toMatchObject({ status: 'detail-only', auditId: summary.auditId });
    expect(statSync(detailsFile).mode & 0o777).toBe(0o600);
    expect(detail.groups.some((group: { normalizedEmail: string }) => group.normalizedEmail === '')).toBe(true);
    expect(result.stdout + result.stderr).not.toContain(secretCanary);
    expect(result.stdout + result.stderr).not.toContain(fixtureSuffix);
    expect(JSON.stringify(detail)).not.toContain(secretCanary);
    const retained = readFileSync(detailsFile);
    const repeated = await invokeCli(['--details-file', detailsFile], {
      ...process.env,
      ACCOUNT_EMAIL_AUDIT_DATABASE_URL: getWorkerDatabaseUrl(),
      DEBUG_SQL: 'false',
    });
    expect(repeated.code).toBe(1);
    expect(JSON.parse(repeated.stdout)).toEqual({ formatVersion: 1, status: 'incomplete', code: 'OUTPUT_UNAVAILABLE' });
    expect(readFileSync(detailsFile)).toEqual(retained);
  });

  it('never falls back to DATABASE_URL and redacts real connection failures', async () => {
    const missing = await invokeCli([], { ...process.env, ACCOUNT_EMAIL_AUDIT_DATABASE_URL: '', DEBUG_SQL: 'false' });
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.stdout)).toMatchObject({ status: 'incomplete', code: 'CONFIGURATION' });
    const unreachable = await invokeCli([], {
      ...process.env,
      DEBUG_SQL: 'false',
      ACCOUNT_EMAIL_AUDIT_DATABASE_URL: `postgresql://private-user:${secretCanary}@127.0.0.1:1/private-database`,
    });
    expect(unreachable.code).toBe(1);
    expect(JSON.parse(unreachable.stdout)).toMatchObject({ status: 'incomplete', code: 'SNAPSHOT_UNAVAILABLE' });
    expect(unreachable.stdout + unreachable.stderr).not.toMatch(/private-user|private-database|postgresql:/);
    expect(unreachable.stdout + unreachable.stderr).not.toContain(secretCanary);
  });

  it('rejects restricted-role RLS visibility instead of claiming a complete empty store', async () => {
    const roleName = `email_audit_${randomUUID().replaceAll('-', '')}`;
    // These objects exist only in the fresh worker fixture. The NOLOGIN role
    // receives SELECT only; no real identity or production grant is touched.
    await writer.unsafe(`CREATE ROLE "${roleName}" NOLOGIN`);
    await writer.unsafe(`GRANT USAGE ON SCHEMA public TO "${roleName}"`);
    await writer.unsafe(
      `GRANT SELECT ON "public"."users", "public"."user_credentials", "public"."accounts" TO "${roleName}"`,
    );
    await writer.unsafe('ALTER TABLE "public"."users" ENABLE ROW LEVEL SECURITY');
    await writer.unsafe('CREATE POLICY "email_audit_visibility_fixture" ON "public"."users" USING (false)');
    await reader.unsafe(`SET ROLE "${roleName}"`);
    try {
      await expect(auditAccountEmailSnapshot(reader)).rejects.toMatchObject({ code: 'SNAPSHOT_UNAVAILABLE' });
    } finally {
      await reader.unsafe('RESET ROLE');
    }
  });

  it('caps oversized database text before emitting any complete report', async () => {
    await drizzle(writer)
      .insert(users)
      .values({ id: `audit-oversize-${fixtureSuffix}`, email: 'a'.repeat(4097) });
    await expect(auditAccountEmailSnapshot(reader)).rejects.toMatchObject({ code: 'INPUT_LIMIT' });
  });
});

describe('audit configuration and private-file boundaries', () => {
  it('pins the installed driver options against hostile ambient PG defaults without opening a connection', async () => {
    const hostile = {
      PGHOST: 'hostile-route.invalid',
      PGPORT: '1',
      PGDATABASE: 'hostile-database',
      PGUSER: 'hostile-user',
      PGUSERNAME: 'hostile-username',
      PGPASSWORD: 'hostile-password',
      PGDEBUG: 'hostile-debug',
      PGFETCH_TYPES: 'true',
      PGTARGETSESSIONATTRS: 'hostile-target',
      PGAPPNAME: 'hostile-application',
      PGSSLNEGOTIATION: 'direct',
    };
    const saved = new Map(Object.keys(hostile).map((name) => [name, process.env[name]]));
    try {
      Object.assign(process.env, hostile);
      const options = emailAuditConnectionOptions(
        'postgresql://audit-user:@127.0.0.1:15478/explicit-audit?sslmode=disable',
      );
      const client = postgres(options);
      try {
        expect(client.options).toMatchObject({
          host: ['127.0.0.1'],
          port: [15478],
          database: 'explicit-audit',
          user: 'audit-user',
          ssl: false,
          debug: false,
          fetch_types: false,
          target_session_attrs: 'primary',
          sslnegotiation: null,
          max: 1,
          max_pipeline: 1,
          keep_alive: 30,
          publications: 'alltables',
          connection: { application_name: 'boardsesh_account_email_audit', default_transaction_read_only: true },
        });
        const password: unknown = (client.options as unknown as Record<string, unknown>).pass;
        expect(typeof password).toBe('function');
        if (typeof password !== 'function') throw new Error('Expected the explicit password callback.');
        expect(await (password as () => string | Promise<string>)()).toBe('');
        const backoff: unknown = (client.options as unknown as Record<string, unknown>).backoff;
        expect(typeof backoff).toBe('function');
        if (typeof backoff !== 'function') throw new Error('Expected the pinned backoff callback.');
        expect((backoff as (retries: number) => number)(1)).toBe(0.1);
      } finally {
        await client.end({ timeout: 1 });
      }
    } finally {
      for (const [name, contents] of saved) {
        if (contents === undefined) delete process.env[name];
        else process.env[name] = contents;
      }
    }
  });

  it('uses explicit driver fields and a password callback even for an empty password', () => {
    const options = emailAuditConnectionOptions('postgresql://audit-user:@localhost/audit-db');
    expect(options).toMatchObject({
      host: 'localhost',
      port: 5432,
      username: 'audit-user',
      database: 'audit-db',
      ssl: false,
    });
    expect(options.password()).toBe('');
    expect(options.connection.default_transaction_read_only).toBe(true);
    expect(emailAuditConnectionOptions('postgresql://audit-user:p%40ss@db.example.test/audit-db').ssl).toEqual({
      rejectUnauthorized: true,
    });
  });
  it.each([
    'postgresql://audit-user:secret@db.example.test/audit-db?sslmode=disable',
    'postgresql://audit-user:secret@db.example.test/audit-db?options=x',
    'postgresql://audit-user:secret@db.example.test/audit-db?sslmode=verify-full&sslmode=verify-full',
    'postgresql://audit-user:secret@localhost/',
    'postgresql://localhost/audit-db',
    'postgresql://audit-user:secret@[::1]/audit-db',
    'postgresql://audit-user:secret@localhost:0/audit-db',
    'postgresql://audit-user:secret@localhost:0000/audit-db',
  ])('rejects ambiguous or unsafe explicit configuration without echoing it', (address) => {
    expect(() => emailAuditConnectionOptions(address)).toThrow(EmailAuditError);
    try {
      emailAuditConnectionOptions(address);
    } catch (error) {
      expect(String(error)).not.toContain('secret');
    }
  });

  it.each([
    ['tab', '\t'],
    ['carriage return', '\r'],
    ['line feed', '\n'],
  ])('rejects raw %s before URL parsing can silently remove it', (_label, control) => {
    for (const address of [
      `postgresql://audit-user:secret@local${control}host/audit-db`,
      `postgresql://audit-user:secret${control}value@localhost/audit-db`,
    ]) {
      expect(() => emailAuditConnectionOptions(address)).toThrow(EmailAuditError);
      try {
        emailAuditConnectionOptions(address);
      } catch (error) {
        expect(error).toMatchObject({ code: 'CONFIGURATION' });
        expect(String(error)).not.toContain('secret');
      }
    }
  });

  it('preserves explicitly encoded password whitespace without URI normalization', () => {
    const options = emailAuditConnectionOptions('postgresql://audit-user:p%09a%0Ds%0As%20@localhost/audit-db');
    expect(options.password()).toBe('p\ta\rs\ns ');
  });
  it('has no apply mode or DSN argument', () => {
    expect(parseEmailAuditArguments([])).toEqual({});
    expect(() => parseEmailAuditArguments(['--apply'])).toThrow(EmailAuditError);
    expect(() => parseEmailAuditArguments(['postgresql://secret'])).toThrow(EmailAuditError);
    expect(() => parseEmailAuditArguments(['--maximum-ms', '25'])).toThrow(EmailAuditError);
  });
  it('never overwrites an existing private report', () => {
    const filename = join(fixtureDirectory, 'existing.json');
    writeFileSync(filename, 'retained', { flag: 'wx', mode: 0o600 });
    expect(() => writeEmailAuditDetails(filename, 'audit-id', [])).toThrow(EmailAuditError);
    expect(readFileSync(filename, 'utf8')).toBe('retained');
  });

  it('enforces the real streaming detail cap and retains an incomplete private artifact without overwrite', () => {
    const filename = join(fixtureDirectory, 'detail-cap.json');
    const email = 'x'.repeat(EMAIL_AUDIT_LIMITS.maxFieldBytes);
    const members = Array.from(
      { length: Math.ceil(EMAIL_AUDIT_LIMITS.maxDetailBytes / email.length) + 1 },
      (_, index) => ({
        userId: `cap-user-${index}`,
        email,
        emailVerified: null,
        hasPassword: false,
        linkedProviderCount: 0,
      }),
    );
    let caught: unknown;
    try {
      writeEmailAuditDetails(filename, 'capped-private-fixture', [{ normalizedEmail: email, members }]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EmailAuditError);
    expect(caught).toMatchObject({ code: 'INPUT_LIMIT' });
    const retained = readFileSync(filename);
    expect(retained.length).toBeGreaterThan(0);
    expect(retained.length).toBeLessThanOrEqual(EMAIL_AUDIT_LIMITS.maxDetailBytes);
    expect(statSync(filename).mode & 0o777).toBe(0o600);
    const prefix = retained.toString('utf8', 0, 150);
    expect(prefix).toContain('"status":"detail-only"');
    expect(prefix).not.toContain('"status":"complete"');
    const retainedHash = createHash('sha256').update(retained).digest('hex');
    expect(() => writeEmailAuditDetails(filename, 'replacement', [])).toThrow(EmailAuditError);
    expect(createHash('sha256').update(readFileSync(filename)).digest('hex')).toBe(retainedHash);
  });
});
