import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import { lockAccountEmailSnapshot } from '@boardsesh/db/queries/account-email';
import { normalizeAccountEmail } from '../../normalize-email';
import {
  applyResolutionPlan,
  buildResolutionPlan,
  digest,
  parseDecisions,
  parseWorksheet,
  type Decisions,
  type ResolutionPlan,
} from '../resolution';
import {
  parseResolutionArguments,
  readResolutionPrivateFile,
  resolutionConnectionOptions,
  runResolutionCli,
} from '../../../scripts/resolve-account-emails';
import { getWorkerDatabaseName } from '../../../__tests__/worker-db';

const adminUrl = (
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/boardsesh_backend_test'
).replace(/\/[^/]+$/, '/postgres');
if (!['localhost', '127.0.0.1'].includes(new URL(adminUrl).hostname)) {
  throw new Error('Resolution tests require a loopback-only disposable database.');
}
const databaseName = getWorkerDatabaseName('bs_email_resolution');
const databaseUrl = adminUrl.replace(/\/[^/]+$/, `/${databaseName}`);
const marker = randomUUID().replaceAll('-', '');
const address = `${marker}@example.test`;
const identities = [randomUUID(), randomUUID()];
const evidenceText = JSON.stringify({
  formatVersion: 1,
  document: 'boardsesh-account-email-evidence',
  groups: [
    {
      group: 'G01',
      address,
      kind: 'A',
      mostRecentlyActive: 'B',
      members: [
        { member: 'A', userId: identities[0], storedEmail: address.toUpperCase() },
        { member: 'B', userId: identities[1], storedEmail: address },
      ],
    },
  ],
});
const worksheet = parseWorksheet(JSON.parse(evidenceText));
const evidenceSha256 = digest(evidenceText);
const decisions: Decisions = {
  formatVersion: 1,
  evidenceSha256,
  normalizeStandalone: false,
  groups: [{ group: 'G01', keeper: 'A', evidenceKind: 'mailbox-reply' }],
};
const options = {
  evidenceSha256,
  decisionsSha256: digest(JSON.stringify(decisions)),
  targetFingerprint: digest('test-target'),
};
// Every ECMAScript trim code point, including line terminators and Unicode spaces.
const trimWhitespaceCases = [
  0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005,
  0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
].map((codePoint) => ({ label: codePoint.toString(16).padStart(4, '0'), whitespace: String.fromCodePoint(codePoint) }));
const folder = mkdtempSync(join(tmpdir(), 'ba02-resolution-test-'));
let admin: ReturnType<typeof postgres>;
let client: ReturnType<typeof postgres>;

const schemaSql = `
CREATE TABLE users (id text PRIMARY KEY, name text, email text NOT NULL, "emailVerified" timestamp,
 image text, created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now());
CREATE TABLE "verificationTokens" (identifier text NOT NULL, token text NOT NULL, expires timestamp NOT NULL, PRIMARY KEY(identifier,token));
CREATE TABLE user_credentials (user_id text PRIMARY KEY REFERENCES users(id), password_hash text NOT NULL);
CREATE TABLE accounts ("userId" text REFERENCES users(id), provider text, "providerAccountId" text);
CREATE TABLE mobile_refresh_tokens (user_id text REFERENCES users(id), token_hash text);
CREATE TABLE ticks (user_id text REFERENCES users(id));
CREATE TABLE auth_email_projection (projection_id text PRIMARY KEY, is_current boolean NOT NULL DEFAULT true,
 normalizer_version text NOT NULL, phase text NOT NULL, writer_epoch integer NOT NULL,
 writer_authority text NOT NULL DEFAULT 'current-store', source_user_count integer NOT NULL DEFAULT 0,
 key_count integer NOT NULL DEFAULT 0, ambiguous_key_count integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), prepared_at timestamptz);
CREATE TABLE auth_email_reservations (normalized_email text PRIMARY KEY, basis_projection_id text NOT NULL REFERENCES auth_email_projection(projection_id),
 state text NOT NULL, owner_user_id text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE auth_email_reservation_members (normalized_email text NOT NULL REFERENCES auth_email_reservations(normalized_email),
 user_id text NOT NULL, observed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(normalized_email,user_id));
`;

async function plan(decisionFile: Decisions = decisions, swapKeeper?: string): Promise<ResolutionPlan> {
  return buildResolutionPlan(drizzle(client), worksheet, decisionFile, { ...options, swapKeeper });
}

beforeAll(async () => {
  admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  client = postgres(databaseUrl, { max: 2, onnotice: () => {} });
  await client.unsafe(schemaSql);
  const migrations = resolve('packages/db/drizzle');
  const migration = readdirSync(migrations).find((entry) => entry.endsWith('_auth_email_resolution_log.sql'));
  if (!migration) throw new Error('Generated resolution migration missing.');
  await client.unsafe(readFileSync(join(migrations, migration), 'utf8'));
  chmodSync(folder, 0o700);
});
afterAll(async () => {
  await client?.end();
  await admin?.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await admin?.end();
});
beforeEach(async () => {
  await client`TRUNCATE users, "verificationTokens", user_credentials, accounts, mobile_refresh_tokens, ticks,
    auth_email_resolution_log, auth_email_projection, auth_email_reservations, auth_email_reservation_members CASCADE`;
  await client`INSERT INTO users (id, email) VALUES (${identities[0]}, ${address.toUpperCase()}), (${identities[1]}, ${address})`;
  await client`INSERT INTO user_credentials VALUES (${identities[0]}, 'synthetic-password-bytes')`;
  await client`INSERT INTO accounts VALUES (${identities[1]}, 'google', 'synthetic-subject')`;
  await client`INSERT INTO mobile_refresh_tokens VALUES (${identities[0]}, 'synthetic-refresh-bytes')`;
  await client`INSERT INTO ticks VALUES (${identities[0]})`;
});

describe('private resolution workflow', () => {
  it('plans without writing, then retires only the address and is idempotent', async () => {
    const before = await client`SELECT * FROM users ORDER BY id`;
    const proposed = await plan();
    expect(proposed.groups[0].status).toBe('ready');
    expect(await client`SELECT * FROM users ORDER BY id`).toEqual(before);
    expect(await applyResolutionPlan(drizzle(client), proposed)).toEqual({ applied: 1, skipped: 0, deferred: 0 });
    expect((await client`SELECT email FROM users WHERE id = ${identities[0]}`)[0].email === address).toBe(true);
    expect((await client`SELECT email FROM users WHERE id = ${identities[1]}`)[0].email.endsWith('.invalid')).toBe(
      true,
    );
    expect(
      (await client`SELECT password_hash FROM user_credentials`)[0].password_hash === 'synthetic-password-bytes',
    ).toBe(true);
    expect((await client`SELECT count(*)::int AS count FROM accounts`)[0].count).toBe(1);
    expect((await client`SELECT count(*)::int AS count FROM mobile_refresh_tokens`)[0].count).toBe(1);
    expect((await client`SELECT count(*)::int AS count FROM ticks`)[0].count).toBe(1);
    expect(await applyResolutionPlan(drizzle(client), proposed)).toEqual({ applied: 0, skipped: 1, deferred: 0 });
    expect((await plan()).groups[0].status).toBe('skipped');
  });

  it('skips membership and stored-address drift between plan and apply', async () => {
    const proposed = await plan();
    await client`UPDATE users SET email = ${`changed-${address}`} WHERE id = ${identities[1]}`;
    expect(await applyResolutionPlan(drizzle(client), proposed)).toEqual({ applied: 0, skipped: 1, deferred: 0 });
    expect((await client`SELECT count(*)::int AS count FROM auth_email_resolution_log`)[0].count).toBe(0);
  });

  it('skips a newly joined collision member', async () => {
    const proposed = await plan();
    await client`INSERT INTO users(id,email) VALUES (${randomUUID()}, ${address})`;
    expect(await applyResolutionPlan(drizzle(client), proposed)).toEqual({ applied: 0, skipped: 1, deferred: 0 });
  });

  it.each(trimWhitespaceCases)('skips a pre-plan collision padded with U+$label', async ({ whitespace }) => {
    await client`INSERT INTO users(id,email) VALUES (${randomUUID()}, ${whitespace + address + whitespace})`;
    expect((await plan()).groups[0].status).toBe('skipped');
    expect((await client`SELECT count(*)::int AS count FROM auth_email_resolution_log`)[0].count).toBe(0);
  });

  it.each(trimWhitespaceCases)('skips apply-time collision drift padded with U+$label', async ({ whitespace }) => {
    const proposed = await plan();
    const newcomerId = randomUUID();
    const newcomerAddress = whitespace + address + whitespace;
    await client`INSERT INTO users(id,email) VALUES (${newcomerId}, ${newcomerAddress})`;
    const before = await client`SELECT id, email FROM users ORDER BY id`;
    expect(await applyResolutionPlan(drizzle(client), proposed)).toEqual({ applied: 0, skipped: 1, deferred: 0 });
    expect(
      (await client`SELECT id, email FROM users ORDER BY id`).every(
        (row, index) => row.id === before[index].id && row.email === before[index].email,
      ),
    ).toBe(true);
    expect((await client`SELECT count(*)::int AS count FROM auth_email_resolution_log`)[0].count).toBe(0);
  });

  it('finds and normalizes lowercase standalone rows with every JS trim code point', async () => {
    const standaloneRows = trimWhitespaceCases.map(({ label, whitespace }) => ({
      userId: randomUUID(),
      before: whitespace + `solo-${label}-${address}` + whitespace,
    }));
    for (const row of standaloneRows) await client`INSERT INTO users(id,email) VALUES (${row.userId}, ${row.before})`;
    const proposed = await plan({ ...decisions, groups: [], normalizeStandalone: true });
    expect(proposed.groups.length).toBe(trimWhitespaceCases.length);
    expect(
      proposed.groups.every(
        (group) =>
          group.status === 'ready' &&
          group.members.length === 1 &&
          group.address === normalizeAccountEmail(group.members[0].before),
      ),
    ).toBe(true);
    expect(await applyResolutionPlan(drizzle(client), proposed)).toEqual({
      applied: trimWhitespaceCases.length,
      skipped: 0,
      deferred: 0,
    });
    for (const row of standaloneRows) {
      const [stored] = await client`SELECT email FROM users WHERE id = ${row.userId}`;
      expect(stored.email === normalizeAccountEmail(row.before)).toBe(true);
    }
  });

  it('skips standalone normalization when a whitespace-padded owner shares its key', async () => {
    for (const { label, whitespace } of trimWhitespaceCases) {
      const canonical = `blocked-${label}-${address}`;
      await client`INSERT INTO users(id,email) VALUES (${randomUUID()}, ${canonical}), (${randomUUID()}, ${whitespace + canonical + whitespace})`;
    }
    const proposed = await plan({ ...decisions, groups: [], normalizeStandalone: true });
    expect(proposed.groups.length).toBe(trimWhitespaceCases.length);
    expect(proposed.groups.every((group) => group.status === 'skipped')).toBe(true);
    expect(await applyResolutionPlan(drizzle(client), proposed)).toEqual({
      applied: 0,
      skipped: trimWhitespaceCases.length,
      deferred: 0,
    });
  });

  it('defers live links at plan time and rechecks links at apply time', async () => {
    const proposed = await plan();
    await client`INSERT INTO "verificationTokens" VALUES (${`password-reset:${address.toUpperCase()}`}, 'synthetic-token', now() + interval '1 hour')`;
    expect((await plan()).groups[0].status).toBe('deferred');
    expect(await applyResolutionPlan(drizzle(client), proposed)).toEqual({ applied: 0, skipped: 0, deferred: 1 });
    expect((await client`SELECT count(*)::int AS count FROM auth_email_resolution_log`)[0].count).toBe(0);
  });

  it('a paused legacy issuer rechecks its original owner after resolution commits', async () => {
    const issuer = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    try {
      // This is the original owner read before entering the old route's transaction.
      const snapshot = { id: identities[1], email: address };
      await applyResolutionPlan(drizzle(client), await plan());
      const issued = await drizzle(issuer).transaction(async (transaction) => {
        if (!(await lockAccountEmailSnapshot(transaction, snapshot))) return false;
        await transaction.execute(
          sql`INSERT INTO "verificationTokens" VALUES (${address}, 'synthetic-late-token', now() + interval '1 hour')`,
        );
        return true;
      });
      expect(issued).toBe(false);
      expect((await client`SELECT count(*)::int AS count FROM "verificationTokens"`)[0].count).toBe(0);
    } finally {
      await issuer.end();
    }
  });

  it('a legacy link committed while resolution waits makes resolution defer', async () => {
    const proposed = await plan();
    const issuer = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    let releaseIssuer!: () => void;
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolveLocked) => {
      signalLocked = resolveLocked;
    });
    const release = new Promise<void>((resolveRelease) => {
      releaseIssuer = resolveRelease;
    });
    const issuing = drizzle(issuer).transaction(async (transaction) => {
      expect(await lockAccountEmailSnapshot(transaction, { id: identities[1], email: address })).toBe(true);
      signalLocked();
      await release;
      await transaction.execute(
        sql`INSERT INTO "verificationTokens" VALUES (${address}, 'synthetic-first-token', now() + interval '1 hour')`,
      );
    });
    try {
      await locked;
      const applying = applyResolutionPlan(drizzle(client), proposed);
      let resolved = false;
      void applying.then(
        () => {
          resolved = true;
        },
        () => {
          resolved = true;
        },
      );
      let observedWait = false;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const [waiting] = await client`SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        if (waiting.count > 0) {
          observedWait = true;
          break;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
      expect(observedWait).toBe(true);
      expect(resolved).toBe(false);
      releaseIssuer();
      await issuing;
      expect(await applying).toEqual({ applied: 0, skipped: 0, deferred: 1 });
    } finally {
      releaseIssuer();
      await issuing;
      await issuer.end();
    }
  });

  it('rolls back the entire group when the resolution log write fails', async () => {
    const proposed = await plan();
    await client.unsafe(`CREATE FUNCTION reject_resolution() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$;
      CREATE TRIGGER reject_resolution BEFORE INSERT ON auth_email_resolution_log FOR EACH ROW EXECUTE FUNCTION reject_resolution();`);
    try {
      await expect(applyResolutionPlan(drizzle(client), proposed)).rejects.toThrow();
      expect(
        (await client`SELECT email FROM users WHERE id = ${identities[0]}`)[0].email === address.toUpperCase(),
      ).toBe(true);
      expect((await client`SELECT email FROM users WHERE id = ${identities[1]}`)[0].email === address).toBe(true);
    } finally {
      await client.unsafe(
        'DROP TRIGGER reject_resolution ON auth_email_resolution_log; DROP FUNCTION reject_resolution()',
      );
    }
  });

  it('swaps the keeper after a unique index exists without changing credentials', async () => {
    await applyResolutionPlan(drizzle(client), await plan());
    await client.unsafe('CREATE UNIQUE INDEX resolution_test_email_unique ON users(lower(email))');
    try {
      const swapped: Decisions = {
        ...decisions,
        groups: [{ group: 'G01', keeper: 'B', evidenceKind: 'mailbox-reply' }],
      };
      expect((await plan(swapped, 'G01')).groups[0].status).toBe('ready');
      expect(await applyResolutionPlan(drizzle(client), await plan(swapped, 'G01'))).toEqual({
        applied: 1,
        skipped: 0,
        deferred: 0,
      });
      expect((await client`SELECT email FROM users WHERE id = ${identities[1]}`)[0].email === address).toBe(true);
    } finally {
      await client.unsafe('DROP INDEX resolution_test_email_unique');
    }
  });

  it('reconciles a prepared reservation projection', async () => {
    await client`INSERT INTO auth_email_projection(projection_id,normalizer_version,phase,writer_epoch,source_user_count,key_count,ambiguous_key_count,prepared_at)
      VALUES ('synthetic-projection','js-trim-lower-v1','prepared',1,2,1,1,now())`;
    await client`INSERT INTO auth_email_reservations VALUES (${address}, 'synthetic-projection', 'blocked_ambiguous', NULL, now())`;
    await client`INSERT INTO auth_email_reservation_members(normalized_email,user_id) VALUES (${address}, ${identities[0]}), (${address}, ${identities[1]})`;
    expect((await applyResolutionPlan(drizzle(client), await plan())).applied).toBe(1);
    const projection = (await client`SELECT key_count, ambiguous_key_count FROM auth_email_projection`)[0];
    expect(projection.key_count).toBe(2);
    expect(projection.ambiguous_key_count).toBe(0);
    expect((await client`SELECT count(*)::int AS count FROM auth_email_reservation_members`)[0].count).toBe(2);
    const swapped: Decisions = { ...decisions, groups: [{ group: 'G01', keeper: 'B', evidenceKind: 'mailbox-reply' }] };
    expect((await applyResolutionPlan(drizzle(client), await plan(swapped, 'G01'))).applied).toBe(1);
    expect((await client`SELECT key_count FROM auth_email_projection`)[0].key_count).toBe(2);
    expect((await client`SELECT count(*)::int AS count FROM auth_email_reservations`)[0].count).toBe(2);
  });

  it('normalizes standalone rows and defers their live verification link', async () => {
    const standaloneId = randomUUID();
    await client`INSERT INTO users(id,email) VALUES (${standaloneId}, ${`SOLO-${address}`})`;
    const withStandalone = { ...decisions, normalizeStandalone: true };
    expect((await plan(withStandalone)).groups.filter((group) => group.status === 'ready').length).toBe(2);
    await client`INSERT INTO "verificationTokens" VALUES (${`SOLO-${address}`}, 'synthetic-token', now() + interval '24 hours')`;
    expect((await plan(withStandalone)).groups.filter((group) => group.status === 'deferred').length).toBe(1);
  });

  it('requires an explicit keeper and enforces contact or the 14-day deadline', async () => {
    expect(() =>
      parseDecisions({ ...decisions, groups: [{ group: 'G01', evidenceKind: 'mailbox-reply' }] }, evidenceSha256),
    ).toThrow();
    await expect(
      plan({ ...decisions, groups: [{ group: 'G01', keeper: 'A', evidenceKind: 'batch-approved' }] }),
    ).rejects.toThrow();
    await expect(
      plan({
        ...decisions,
        groups: [
          { group: 'G01', keeper: 'B', evidenceKind: 'no-reply-14-days', contactedAt: new Date().toISOString() },
        ],
      }),
    ).rejects.toThrow();
    const oldContact = new Date(Date.now() - 15 * 86400000).toISOString();
    expect(
      (
        await plan({
          ...decisions,
          groups: [{ group: 'G01', keeper: 'B', evidenceKind: 'no-reply-14-days', contactedAt: oldContact }],
        })
      ).groups[0].status,
    ).toBe('ready');
  });

  it('round-trips a CLI plan with a missing member and applies an unaffected ready group', async () => {
    const unaffectedIds = [randomUUID(), randomUUID()];
    const unaffectedAddress = `unaffected-${address}`;
    await client`INSERT INTO users(id,email) VALUES
      (${unaffectedIds[0]}, ${unaffectedAddress.toUpperCase()}), (${unaffectedIds[1]}, ${unaffectedAddress})`;
    await client`DELETE FROM accounts WHERE "userId"=${identities[1]}`;
    await client`DELETE FROM users WHERE id=${identities[1]}`;
    const originalEvidence = JSON.parse(evidenceText) as { groups: readonly unknown[] };
    const mixedEvidenceText = JSON.stringify({
      formatVersion: 1,
      document: 'boardsesh-account-email-evidence',
      groups: [
        ...originalEvidence.groups,
        {
          group: 'G02',
          address: unaffectedAddress,
          kind: 'A',
          mostRecentlyActive: 'B',
          members: [
            { member: 'A', userId: unaffectedIds[0], storedEmail: unaffectedAddress.toUpperCase() },
            { member: 'B', userId: unaffectedIds[1], storedEmail: unaffectedAddress },
          ],
        },
      ],
    });
    const mixedDecisions: Decisions = {
      ...decisions,
      evidenceSha256: digest(mixedEvidenceText),
      groups: [...decisions.groups, { group: 'G02', keeper: 'A', evidenceKind: 'mailbox-reply' }],
    };
    const evidencePath = join(folder, 'mixed-missing-evidence.json');
    const decisionsPath = join(folder, 'mixed-missing-decisions.json');
    const planPath = join(folder, 'mixed-missing-plan.json');
    writeFileSync(evidencePath, mixedEvidenceText, { mode: 0o600, flag: 'wx' });
    writeFileSync(decisionsPath, JSON.stringify(mixedDecisions), { mode: 0o600, flag: 'wx' });
    const environment = { ACCOUNT_EMAIL_RESOLVE_DATABASE_URL: databaseUrl };
    let plannedOutput = '';
    expect(
      await runResolutionCli(
        [
          '--plan',
          '--evidence',
          evidencePath,
          '--decisions',
          decisionsPath,
          '--plan-file',
          planPath,
          '--confirm-host',
          new URL(databaseUrl).hostname,
        ],
        environment,
        (text) => {
          plannedOutput += text;
        },
      ),
    ).toBe(0);
    const planned = JSON.parse(plannedOutput) as { ready: number; skipped: number; planSha256: string };
    expect({ ready: planned.ready, skipped: planned.skipped }).toEqual({ ready: 1, skipped: 1 });
    const generated = JSON.parse(readFileSync(planPath, 'utf8')) as ResolutionPlan;
    expect(generated.groups[0].status).toBe('skipped');
    expect(generated.groups[0].members.some((member) => member.before === '')).toBe(true);
    let appliedOutput = '';
    expect(
      await runResolutionCli(
        [
          '--apply',
          '--plan-file',
          planPath,
          '--plan-sha256',
          planned.planSha256,
          '--confirm-host',
          new URL(databaseUrl).hostname,
        ],
        environment,
        (text) => {
          appliedOutput += text;
        },
      ),
    ).toBe(0);
    const applied = JSON.parse(appliedOutput) as { applied: number; skipped: number; deferred: number };
    expect({ applied: applied.applied, skipped: applied.skipped, deferred: applied.deferred }).toEqual({
      applied: 1,
      skipped: 1,
      deferred: 0,
    });
    const untouched = await client`SELECT email FROM users WHERE id=${identities[0]}`;
    expect(untouched[0].email === address.toUpperCase()).toBe(true);
    const normalized = await client`SELECT email FROM users WHERE id=${unaffectedIds[0]}`;
    expect(normalized[0].email === unaffectedAddress).toBe(true);
    const retired = await client`SELECT email FROM users WHERE id=${unaffectedIds[1]}`;
    expect(String(retired[0].email).endsWith('@retired.boardsesh.invalid')).toBe(true);
    const output = plannedOutput + appliedOutput;
    expect(
      [address, unaffectedAddress, ...identities, ...unaffectedIds].some((privateText) => output.includes(privateText)),
    ).toBe(false);
  });

  it.each(['ready', 'deferred'] as const)('rejects an empty before address in a %s group', async (status) => {
    const proposed = await plan();
    const connection = resolutionConnectionOptions(databaseUrl, undefined, new URL(databaseUrl).hostname, true);
    const malformed = {
      ...proposed,
      targetFingerprint: digest(`${connection.host}:${connection.port}/${connection.database}`),
      groups: proposed.groups.map((group) => ({
        ...group,
        status,
        members: group.members.map((member, index) => ({ ...member, before: index === 0 ? '' : member.before })),
      })),
    };
    const path = join(folder, `empty-before-${status}.json`);
    const contents = JSON.stringify(malformed);
    writeFileSync(path, contents, { mode: 0o600, flag: 'wx' });
    let output = '';
    expect(
      await runResolutionCli(
        [
          '--apply',
          '--plan-file',
          path,
          '--confirm-host',
          new URL(databaseUrl).hostname,
          '--plan-sha256',
          digest(contents),
        ],
        { ACCOUNT_EMAIL_RESOLVE_DATABASE_URL: databaseUrl },
        (text) => {
          output += text;
        },
      ),
    ).toBe(1);
    expect(JSON.parse(output).code).toBe('DATABASE');
    expect((await client`SELECT count(*)::integer AS count FROM auth_email_resolution_log`)[0].count).toBe(0);
  });

  it('requires the private exact plan hash before opening a database', async () => {
    const path = join(folder, 'tampered-plan.json');
    writeFileSync(path, '{}', { mode: 0o600 });
    let output = '';
    const status = await runResolutionCli(
      ['--apply', '--plan-file', path, '--confirm-host', 'localhost', '--plan-sha256', '0'.repeat(64)],
      { ACCOUNT_EMAIL_RESOLVE_DATABASE_URL: databaseUrl },
      (text) => {
        output += text;
      },
    );
    expect(status).toBe(1);
    expect(JSON.parse(output).code).toBe('PLAN_HASH');
    expect(output.includes(address) || identities.some((identity) => output.includes(identity))).toBe(false);
  });

  it('rejects public, symlinked and repository private inputs', () => {
    const path = join(folder, 'public.json');
    writeFileSync(path, '{}', { mode: 0o644 });
    expect(() => readResolutionPrivateFile(path)).toThrow();
    chmodSync(path, 0o600);
    const link = join(folder, 'link.json');
    symlinkSync(path, link);
    expect(() => readResolutionPrivateFile(link)).toThrow();
    const repository = join(folder, 'repo');
    mkdirSync(repository, { mode: 0o700 });
    writeFileSync(join(repository, '.git'), 'worktree');
    const privatePath = join(repository, 'private.json');
    writeFileSync(privatePath, '{}', { mode: 0o600 });
    expect(() => readResolutionPrivateFile(privatePath)).toThrow();
  });

  it('uses one explicit URL, checks the host and TLS, and refuses SQL debugging', () => {
    expect(() => resolutionConnectionOptions(undefined, undefined, 'localhost', false)).toThrow();
    expect(() => resolutionConnectionOptions(databaseUrl, '1', 'localhost', false)).toThrow();
    expect(() => resolutionConnectionOptions(databaseUrl, undefined, 'wrong-host', false)).toThrow();
    expect(() =>
      resolutionConnectionOptions(
        'postgres://role:secret@remote.test/db?sslmode=disable',
        undefined,
        'remote.test',
        false,
      ),
    ).toThrow();
    const readOnly = resolutionConnectionOptions(databaseUrl, undefined, 'localhost', false);
    expect(readOnly.connection.default_transaction_read_only).toBe(true);
    expect(
      parseResolutionArguments([
        '--evidence',
        '/evidence',
        '--decisions',
        '/decisions',
        '--plan-file',
        '/plan',
        '--confirm-host',
        'localhost',
      ]).apply,
    ).toBe(false);
  });

  it('the real migration has no email column and no users foreign key', async () => {
    const columns =
      await client`SELECT column_name FROM information_schema.columns WHERE table_name = 'auth_email_resolution_log'`;
    expect(columns.some((column) => String(column.column_name).includes('email'))).toBe(false);
    const constraints =
      await client`SELECT count(*)::int AS count FROM pg_constraint WHERE conrelid='auth_email_resolution_log'::regclass AND contype='f'`;
    expect(constraints[0].count).toBe(0);
  });
});
