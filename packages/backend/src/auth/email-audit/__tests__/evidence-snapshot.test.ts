import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { getWorkerDatabaseName } from '../../../__tests__/worker-db';
import {
  buildAccountEmailEvidence,
  FIXED_SYSTEM_ACCOUNT_IDS,
  OWN_DATA_RULES,
  type CollectedEvidence,
  type EvidenceWorksheet,
} from '../evidence';
import { collectAccountEmailEvidence } from '../evidence-snapshot';
import {
  accountEmailEvidenceConnectionOptions,
  parseAccountEmailEvidenceArguments,
  resolveWorksheetPath,
  writeEvidenceWorksheet,
  runAccountEmailEvidenceCli,
} from '../../../scripts/account-email-evidence';

/**
 * Runs the evidence report against its own throwaway database holding only
 * synthetic rows shaped like the 2026-11-11 audit: 30 groups (28 of 2, 1 of 3,
 * 1 of 7), one exact-duplicate string, 50 standalone mixed-case rows, the three
 * fixed system accounts without a login, and a percentile row for every user.
 * Under the own-data rule the audit counted A 17, B 3, C 5, D 5, E 0.
 */

const checkoutRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const adminUrl = (
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/boardsesh_backend_test'
).replace(/\/[^/]+$/, '/postgres');
const databaseName = getWorkerDatabaseName('bs_email_evidence');
const databaseUrl = adminUrl.replace(/\/[^/]+$/, `/${databaseName}`);
const outputDirectory = mkdtempSync(join(tmpdir(), 'boardsesh-email-evidence-'));

// Every synthetic address, ID and name carries this marker, so one scan of
// stdout proves none of them leaked.
const marker = `ev${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const secretCanary = `never-selected-${marker}`;

const SCHEMA = `
CREATE TABLE users (id text PRIMARY KEY, name text, email text NOT NULL, "emailVerified" timestamp, image text,
  created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now());
CREATE TABLE accounts ("userId" text NOT NULL REFERENCES users(id), type text NOT NULL, provider text NOT NULL,
  "providerAccountId" text NOT NULL, access_token text, refresh_token text, id_token text,
  PRIMARY KEY (provider, "providerAccountId"));
CREATE TABLE user_credentials (user_id text PRIMARY KEY REFERENCES users(id), password_hash text NOT NULL);
CREATE TABLE user_profiles (user_id text PRIMARY KEY REFERENCES users(id), display_name text);
CREATE TABLE sessions ("sessionToken" text PRIMARY KEY, "userId" text NOT NULL REFERENCES users(id), expires timestamp NOT NULL);
CREATE TABLE mobile_refresh_tokens (id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id),
  token_hash text NOT NULL, expires_at timestamp NOT NULL, created_at timestamp NOT NULL DEFAULT now(), revoked_at timestamp);
CREATE TABLE "verificationTokens" (identifier text NOT NULL, token text NOT NULL, expires timestamp NOT NULL,
  PRIMARY KEY (identifier, token));
CREATE TABLE auth_email_verification_tokens (token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL, consumed_at timestamptz, superseded_at timestamptz);
CREATE TABLE auth_password_recovery_tokens (token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL, consumed_at timestamptz, superseded_at timestamptz);
CREATE TABLE user_climb_percentiles (user_id text PRIMARY KEY REFERENCES users(id), percentile integer NOT NULL DEFAULT 50);
CREATE TABLE community_roles (id bigserial PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), role text NOT NULL,
  board_type text, granted_by text REFERENCES users(id));
CREATE TABLE gyms (id bigserial PRIMARY KEY, owner_id text NOT NULL REFERENCES users(id), deleted_at timestamp);
CREATE TABLE gym_members (id bigserial PRIMARY KEY, gym_id bigint NOT NULL REFERENCES gyms(id),
  user_id text NOT NULL REFERENCES users(id), role text NOT NULL);
CREATE TABLE user_activity_days (user_id text NOT NULL REFERENCES users(id), day date NOT NULL,
  platform text NOT NULL DEFAULT 'ios', PRIMARY KEY (user_id, day, platform));
CREATE TABLE boardsesh_ticks (id bigserial PRIMARY KEY, user_id text NOT NULL REFERENCES users(id),
  climbed_at timestamp NOT NULL DEFAULT now());
CREATE INDEX boardsesh_ticks_user_idx ON boardsesh_ticks (user_id);
CREATE TABLE playlists (id bigserial PRIMARY KEY, owner_id text REFERENCES users(id));
CREATE TABLE user_follows (id bigserial PRIMARY KEY, follower_id text NOT NULL REFERENCES users(id),
  following_id text NOT NULL REFERENCES users(id));
CREATE TABLE feed_items (id bigserial PRIMARY KEY, recipient_id text NOT NULL REFERENCES users(id), actor_id text REFERENCES users(id));
CREATE TABLE notifications (id bigserial PRIMARY KEY, recipient_id text NOT NULL REFERENCES users(id), actor_id text REFERENCES users(id));
-- Partitioned and unindexed: counted once, through the parent.
CREATE TABLE board_climb_events (user_id text REFERENCES users(id), created_at timestamp NOT NULL) PARTITION BY RANGE (created_at);
CREATE TABLE board_climb_events_2025 PARTITION OF board_climb_events FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
CREATE TABLE board_climb_events_2026 PARTITION OF board_climb_events FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
-- Outside the public schema.
CREATE SCHEMA archive;
CREATE TABLE archive.legacy_notes (id bigserial PRIMARY KEY, author_id text NOT NULL REFERENCES public.users(id));
CREATE TABLE user_follow_requests (requester_id text NOT NULL REFERENCES users(id), recipient_id text NOT NULL REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now(), PRIMARY KEY (requester_id, recipient_id));
CREATE TABLE resource_grants (kind text NOT NULL, resource_id text NOT NULL, user_id text NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'pending', invited_by text REFERENCES users(id), PRIMARY KEY (kind, resource_id, user_id));
`;

type OwnKind =
  | 'tick'
  | 'playlist'
  | 'follow-given'
  | 'gym-owner'
  | 'activity'
  | 'climb-event'
  | 'archive-note'
  | 'feed-actor'
  | 'role-granter'
  | 'grant-accepted';
type ExcludedKind =
  | 'feed-recipient'
  | 'notification-recipient'
  | 'followed'
  | 'web-session'
  | 'staged-token'
  | 'follow-request-received'
  | 'role-granted'
  | 'pending-invite';

interface MemberSpec {
  readonly own?: readonly OwnKind[];
  readonly excluded?: readonly ExcludedKind[];
  readonly stamped?: boolean;
  readonly password?: boolean;
  readonly providers?: readonly string[];
  readonly liveToken?: boolean;
  readonly deadToken?: boolean;
  readonly legacyResetLink?: boolean;
  /** Stores the group's normalized address exactly, making an exact-duplicate string. */
  readonly exactDuplicate?: boolean;
}

interface GroupSpec {
  readonly kind: 'A' | 'B' | 'C' | 'D' | 'E';
  readonly members: readonly MemberSpec[];
}

const OWN_ROTATION: readonly OwnKind[] = [
  'tick',
  'playlist',
  'follow-given',
  'gym-owner',
  'activity',
  'climb-event',
  'archive-note',
  'feed-actor',
  'role-granter',
  'grant-accepted',
];

function auditShapedGroups(): GroupSpec[] {
  const groups: GroupSpec[] = [];
  // 15 kind A pairs. Each first member's only data sits in a different table,
  // so an uncounted table (partitioned, non-public) would demote a group.
  for (let index = 0; index < 15; index += 1)
    groups.push({
      kind: 'A',
      members: [
        { own: [OWN_ROTATION[index % OWN_ROTATION.length] ?? 'tick'], stamped: true, password: true },
        index < 11 ? { own: ['tick'], providers: ['google'] } : { own: ['tick'], password: true },
      ],
    });
  groups.push({
    kind: 'A',
    members: [
      { own: ['tick'], stamped: true, password: true },
      { own: ['tick'], providers: ['apple'] },
      { stamped: true, password: true },
    ],
  });
  groups.push({
    kind: 'A',
    members: [
      { own: ['tick'], stamped: true, password: true },
      { own: ['playlist'], stamped: true, password: true, exactDuplicate: true },
      { own: ['tick'], providers: ['google'], exactDuplicate: true },
      { password: true, exactDuplicate: true, excluded: ['pending-invite'] },
      { stamped: true, password: true },
      { password: true, excluded: ['feed-recipient'] },
      { password: true },
    ],
  });
  for (let index = 0; index < 3; index += 1)
    groups.push({
      kind: 'B',
      members: [
        { own: ['tick'], stamped: false, password: true, liveToken: true },
        {
          stamped: true,
          password: true,
          excluded: ['followed', 'follow-request-received', ...(index === 0 ? (['role-granted'] as const) : [])],
        },
      ],
    });
  for (let index = 0; index < 5; index += 1)
    groups.push({
      kind: 'C',
      members: [
        { own: ['tick'], stamped: true, password: true, liveToken: index === 0 },
        {
          password: true,
          excluded: ['feed-recipient', 'web-session', ...(index === 1 ? (['staged-token'] as const) : [])],
          providers: index === 2 ? ['facebook'] : [],
          deadToken: index === 3,
          legacyResetLink: index === 0,
        },
      ],
    });
  for (let index = 0; index < 5; index += 1)
    groups.push({
      kind: 'D',
      members: [
        { own: ['tick'], stamped: true, password: true, liveToken: true },
        index < 3
          ? { providers: ['google'], excluded: ['notification-recipient'] }
          : { password: true, liveToken: true, excluded: ['notification-recipient'] },
      ],
    });
  return groups;
}

interface Fixture {
  readonly userIds: string[];
  readonly emails: string[];
  readonly names: string[];
}

const fixture: Fixture = { userIds: [], emails: [], names: [] };
let admin: postgres.Sql;
let writer: postgres.Sql;
let rowSequence = 0;

function at(dayOffset: number): string {
  return new Date(Date.UTC(2026, 0, 15) + dayOffset * 86400000).toISOString().replace('T', ' ').slice(0, 19);
}

async function insertUser(user: {
  id: string;
  email: string;
  joined: string;
  stamped?: boolean;
  password?: boolean;
  providers?: readonly string[];
  profile?: boolean;
}) {
  const name = `Name ${user.id}`;
  fixture.userIds.push(user.id);
  fixture.emails.push(user.email);
  fixture.names.push(name);
  await writer`INSERT INTO users (id, name, email, "emailVerified", created_at)
    VALUES (${user.id}, ${name}, ${user.email}, ${user.stamped ? user.joined : null}, ${user.joined})`;
  await writer`INSERT INTO user_climb_percentiles (user_id) VALUES (${user.id})`;
  if (user.profile) {
    const displayName = `Climber ${user.id}`;
    fixture.names.push(displayName);
    await writer`INSERT INTO user_profiles (user_id, display_name) VALUES (${user.id}, ${displayName})`;
  }
  if (user.password)
    await writer`INSERT INTO user_credentials (user_id, password_hash) VALUES (${user.id}, ${secretCanary})`;
  for (const provider of user.providers ?? []) {
    rowSequence += 1;
    await writer`INSERT INTO accounts ("userId", type, provider, "providerAccountId", access_token, refresh_token, id_token)
      VALUES (${user.id}, 'oauth', ${provider}, ${`${secretCanary}-${rowSequence}`}, ${secretCanary}, ${secretCanary}, ${secretCanary})`;
  }
}

async function insertOwn(kind: OwnKind, userId: string, otherUserId: string) {
  if (kind === 'tick') await writer`INSERT INTO boardsesh_ticks (user_id, climbed_at) VALUES (${userId}, ${at(200)})`;
  if (kind === 'playlist') await writer`INSERT INTO playlists (owner_id) VALUES (${userId})`;
  if (kind === 'follow-given')
    await writer`INSERT INTO user_follows (follower_id, following_id) VALUES (${userId}, ${otherUserId})`;
  if (kind === 'gym-owner') await writer`INSERT INTO gyms (owner_id) VALUES (${userId})`;
  if (kind === 'activity') await writer`INSERT INTO user_activity_days (user_id, day) VALUES (${userId}, '2026-10-01')`;
  if (kind === 'climb-event')
    await writer`INSERT INTO board_climb_events (user_id, created_at) VALUES (${userId}, '2025-06-01'), (${userId}, '2026-06-01')`;
  if (kind === 'archive-note') await writer`INSERT INTO archive.legacy_notes (author_id) VALUES (${userId})`;
  if (kind === 'feed-actor')
    await writer`INSERT INTO feed_items (recipient_id, actor_id) VALUES (${otherUserId}, ${userId})`;
  if (kind === 'role-granter')
    await writer`INSERT INTO community_roles (user_id, role, granted_by) VALUES (${otherUserId}, 'tester', ${userId})`;
  if (kind === 'grant-accepted') {
    rowSequence += 1;
    await writer`INSERT INTO resource_grants (kind, resource_id, user_id, status, invited_by)
      VALUES ('board', ${`r${rowSequence}`}, ${userId}, 'approved', ${otherUserId})`;
  }
}

async function insertExcluded(kind: ExcludedKind, userId: string, otherUserId: string) {
  rowSequence += 1;
  if (kind === 'feed-recipient')
    await writer`INSERT INTO feed_items (recipient_id, actor_id) VALUES (${userId}, ${otherUserId})`;
  if (kind === 'notification-recipient')
    await writer`INSERT INTO notifications (recipient_id, actor_id) VALUES (${userId}, ${otherUserId})`;
  if (kind === 'followed')
    await writer`INSERT INTO user_follows (follower_id, following_id) VALUES (${otherUserId}, ${userId})`;
  if (kind === 'web-session')
    await writer`INSERT INTO sessions ("sessionToken", "userId", expires) VALUES (${`${secretCanary}-s${rowSequence}`}, ${userId}, '2099-01-01')`;
  if (kind === 'follow-request-received')
    await writer`INSERT INTO user_follow_requests (requester_id, recipient_id) VALUES (${otherUserId}, ${userId})`;
  if (kind === 'role-granted')
    await writer`INSERT INTO community_roles (user_id, role, granted_by) VALUES (${userId}, 'admin', ${otherUserId})`;
  if (kind === 'pending-invite')
    await writer`INSERT INTO resource_grants (kind, resource_id, user_id, status, invited_by)
      VALUES ('board', ${`r${rowSequence}`}, ${userId}, 'pending', ${otherUserId})`;
  if (kind === 'staged-token')
    await writer`INSERT INTO auth_password_recovery_tokens (token_hash, user_id, expires_at)
      VALUES (${`${secretCanary}-r${rowSequence}`}, ${userId}, '2099-01-01T00:00:00Z')`;
}

async function insertGroup(spec: GroupSpec, groupIndex: number, otherUserId: string) {
  const base = `member${String(groupIndex).padStart(2, '0')}.${marker}@example.test`;
  const ids: string[] = [];
  for (const [memberIndex, member] of spec.members.entries()) {
    const id = `${marker}-g${groupIndex}-${memberIndex}`;
    ids.push(id);
    // The first member stores the normalized address; the rest differ only in capitals.
    const email =
      memberIndex === 0 || member.exactDuplicate
        ? base
        : `${base.slice(0, memberIndex).toUpperCase()}${base.slice(memberIndex)}`;
    const joined = at(groupIndex + memberIndex * 40);
    await insertUser({
      id,
      email,
      joined,
      stamped: member.stamped,
      password: member.password,
      providers: member.providers,
      profile: true,
    });
    for (const own of member.own ?? []) await insertOwn(own, id, otherUserId);
    for (const excluded of member.excluded ?? []) await insertExcluded(excluded, id, otherUserId);
    rowSequence += 1;
    if (member.liveToken)
      await writer`INSERT INTO mobile_refresh_tokens (id, user_id, token_hash, expires_at)
        VALUES (${`t${rowSequence}`}, ${id}, ${secretCanary}, '2099-01-01')`;
    if (member.deadToken)
      await writer`INSERT INTO mobile_refresh_tokens (id, user_id, token_hash, expires_at, revoked_at)
        VALUES (${`t${rowSequence}`}, ${id}, ${secretCanary}, '2099-01-01', '2026-02-01')`;
    if (member.legacyResetLink)
      await writer`INSERT INTO "verificationTokens" (identifier, token, expires)
        VALUES (${`password-reset:${email}`}, ${secretCanary}, '2099-01-01')`;
  }
  return ids;
}

function evidenceEnvironment(extra: Record<string, string> = {}) {
  return { ACCOUNT_EMAIL_EVIDENCE_DATABASE_URL: databaseUrl, DEBUG_SQL: 'false', ...extra };
}

async function runCli(arguments_: string[], environment: Record<string, string | undefined> = evidenceEnvironment()) {
  let stdout = '';
  const exitCode = await runAccountEmailEvidenceCli(arguments_, environment, (text) => {
    stdout += text;
  });
  return { exitCode, stdout, summary: JSON.parse(stdout) };
}

async function collectDirectly(): Promise<CollectedEvidence> {
  const client = postgres(accountEmailEvidenceConnectionOptions(databaseUrl, 'false'));
  try {
    return await collectAccountEmailEvidence(client, { allowPrimary: true });
  } finally {
    await client.end({ timeout: 5 });
  }
}

/** No synthetic address, ID or name reaches the given text. Report stdout also carries no "@" at all. */
function expectNoPrivateData(text: string, { reportStdout = true, sqlText = false } = {}) {
  expect(text).not.toContain(marker);
  expect(text).not.toContain('example.test');
  expect(text).not.toContain(secretCanary);
  if (reportStdout) expect(text).not.toContain('@');
  // The three fixed system IDs are public code constants; SQL text may name them, output never does.
  const fixedIds = new Set(FIXED_SYSTEM_ACCOUNT_IDS);
  for (const value of [...fixture.userIds, ...fixture.emails, ...fixture.names, ...FIXED_SYSTEM_ACCOUNT_IDS])
    if (!(sqlText && fixedIds.has(value))) expect(text).not.toContain(value);
}

let firstGroupMemberIds: string[][] = [];

describe.sequential('account email evidence on real Postgres', () => {
  beforeAll(async () => {
    admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
    await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    writer = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    await writer.unsafe(SCHEMA);

    // Five ordinary users other people's rows point at, and the fixed system accounts with no login.
    const others: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const id = `${marker}-other-${index}`;
      others.push(id);
      await insertUser({ id, email: `other${index}.${marker}@example.test`, joined: at(index), password: true });
    }
    for (const [index, id] of FIXED_SYSTEM_ACCOUNT_IDS.entries())
      await insertUser({ id, email: `system${index}.${marker}@example.test`, joined: at(0) });
    for (let index = 0; index < 50; index += 1)
      await insertUser({
        id: `${marker}-solo-${index}`,
        email: `Solo${index}.${marker}@example.test`,
        joined: at(index),
        password: true,
      });
    const groups = auditShapedGroups();
    firstGroupMemberIds = [];
    for (const [index, spec] of groups.entries())
      firstGroupMemberIds.push(await insertGroup(spec, index, others[index % others.length] ?? ''));
  }, 120000);

  afterAll(async () => {
    await writer?.end({ timeout: 5 }).catch(() => {});
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => {});
      await admin.end({ timeout: 5 }).catch(() => {});
    }
  });

  it('matches the audit kind counts and writes a private worksheet; stdout holds counts only', async () => {
    const out = join(outputDirectory, 'evidence-audit-shape.json');
    const { exitCode, stdout, summary } = await runCli(['--out', out, '--allow-primary']);
    expect(exitCode).toBe(0);
    expectNoPrivateData(stdout);
    expect(summary).toMatchObject({
      status: 'complete',
      connectionClosed: true,
      snapshot: { target: 'primary', readOnly: true, isolation: 'repeatable read' },
      users: 66 + 50 + 5 + 3,
      groups: 30,
      usersInGroups: 66,
      groupsBySize: { 2: 28, 3: 1, 7: 1 },
      exactDuplicateStrings: 1,
      groupsWithExactDuplicateString: 1,
      groupsByKind: { A: 17, B: 3, C: 5, D: 5, E: 0 },
      contactEmails: 17,
      groupsWithProposedKeeper: 13,
      addresses: { nonNormalizedStandalone: 50, nonAscii: 0, sqlLowerDiffersFromJs: 0, edgeWhitespace: 0 },
      login: { usersWithoutLoginMethod: 3, fixedSystemAccountsWithoutLogin: 3 },
      members: { total: 66, withPendingLink: 2 },
      // 27 foreign keys to users: partitions and the archive schema are found from the catalog.
      catalog: {
        referencingColumns: 27,
        referencingTables: 21,
        ownDataColumns: 14,
        excludedColumns: 13,
        unindexedColumns: 21,
      },
      checks: { kindsSumToGroups: true, sqlLowerMatchesJs: true, noLoginRowsAreFixedSystemAccounts: true },
    });

    const bytes = readFileSync(out);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(summary.worksheet).toEqual({
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    });
    const text = bytes.toString('utf8');
    expect(text).not.toContain(secretCanary);
    const worksheet = JSON.parse(text) as EvidenceWorksheet;
    expect(worksheet.groups).toHaveLength(30);
    expect(worksheet.contactList).toHaveLength(17);
    expect(worksheet.groups.map((group) => group.group)).toEqual(
      Array.from({ length: 30 }, (_, index) => `G${String(index + 1).padStart(2, '0')}`),
    );
    // The worksheet is where the private detail lives.
    expect(text).toContain(marker);
    const byUser = new Map(
      worksheet.groups.flatMap((group) => group.members.map((member) => [member.userId, { group, member }])),
    );
    const partitionOnly = byUser.get(firstGroupMemberIds[5]?.[0] ?? '');
    expect(partitionOnly?.member.ownData.rows).toEqual({ 'public.board_climb_events.user_id': 2 });
    expect(partitionOnly?.group.kind).toBe('A');
    expect(byUser.get(firstGroupMemberIds[6]?.[0] ?? '')?.member.ownData.rows).toEqual({
      'archive.legacy_notes.author_id': 1,
    });
    // Granting a role is own data; an accepted grant is own data.
    expect(byUser.get(firstGroupMemberIds[8]?.[0] ?? '')?.member.ownData.rows).toEqual({
      'public.community_roles.granted_by': 1,
    });
    expect(byUser.get(firstGroupMemberIds[9]?.[0] ?? '')?.member.ownData.rows).toEqual({
      'public.resource_grants.user_id': 1,
    });
    // Rows others caused: a role granted, a follow request received, a pending invite from someone else.
    const receivedOnly = byUser.get(firstGroupMemberIds[17]?.[1] ?? '');
    expect(receivedOnly?.group.kind).toBe('B');
    expect(receivedOnly?.member).toMatchObject({ hasOwnData: false, roles: { community: ['admin:global'] } });
    expect(receivedOnly?.member.excludedRows).toMatchObject({
      'public.community_roles.user_id': 1,
      'public.user_follow_requests.recipient_id': 1,
      'public.user_follows.following_id': 1,
    });
    const invited = byUser.get(firstGroupMemberIds[16]?.[3] ?? '')?.member;
    expect(invited?.hasOwnData).toBe(false);
    expect(invited?.excludedRows).toMatchObject({ 'public.resource_grants.user_id:pending-invite': 1 });
    // Groups 0-16 are kind A, 17-19 B, 20-24 C, 25-29 D.
    const cGroup = byUser.get(firstGroupMemberIds[20]?.[0] ?? '');
    expect(cGroup?.group).toMatchObject({ kind: 'C', proposal: { contact: false, keep: 'A', retireAddress: ['B'] } });
    const cEmpty = cGroup?.group.members[1];
    expect(cEmpty).toMatchObject({ hasOwnData: false, pendingLinks: { legacyReset: 1 } });
    expect(Object.keys(cEmpty?.excludedRows ?? {})).toEqual(
      expect.arrayContaining([
        'public.feed_items.recipient_id',
        'public.sessions.userId',
        'public.user_climb_percentiles.user_id',
      ]),
    );
    const facebookOnly = byUser.get(firstGroupMemberIds[22]?.[1] ?? '')?.member;
    expect(facebookOnly).toMatchObject({ providers: ['facebook'], hasLoginMethod: true, hasOwnData: false });
    // A revoked token is not live.
    expect(byUser.get(firstGroupMemberIds[23]?.[1] ?? '')?.member.liveRefreshTokens).toBe(0);
    expect(byUser.get(firstGroupMemberIds[25]?.[1] ?? '')?.group).toMatchObject({ kind: 'D' });
  });

  it('refuses to overwrite an existing worksheet and leaves its bytes alone', async () => {
    const out = join(outputDirectory, 'existing.json');
    writeFileSync(out, 'retained', { flag: 'wx', mode: 0o600 });
    const { exitCode, stdout, summary } = await runCli(['--out', out, '--allow-primary']);
    expect(exitCode).toBe(1);
    expect(summary).toMatchObject({ status: 'incomplete', code: 'OUTPUT_EXISTS' });
    expectNoPrivateData(stdout);
    expect(readFileSync(out, 'utf8')).toBe('retained');
  });

  it('refuses a worksheet path inside this checkout before connecting', async () => {
    const out = join(checkoutRoot, `evidence-${marker}.json`);
    const { exitCode, stdout, summary } = await runCli(['--out', out, '--allow-primary']);
    expect(exitCode).toBe(1);
    expect(summary).toMatchObject({ status: 'incomplete', code: 'OUTPUT_INSIDE_REPOSITORY' });
    expectNoPrivateData(stdout);
    expect(existsSync(out)).toBe(false);
  });

  it('refuses a primary without --allow-primary and writes nothing', async () => {
    const out = join(outputDirectory, 'refused-primary.json');
    const { exitCode, stdout, summary } = await runCli(['--out', out]);
    expect(exitCode).toBe(1);
    expect(summary).toMatchObject({ status: 'incomplete', code: 'PRIMARY_NOT_ALLOWED' });
    expectNoPrivateData(stdout);
    expect(existsSync(out)).toBe(false);
  });

  it('reads through a transaction PostgreSQL itself keeps read-only', async () => {
    const client = postgres(accountEmailEvidenceConnectionOptions(databaseUrl, 'false'));
    try {
      const [session] = await client<
        { readOnly: string }[]
      >`SELECT pg_catalog.current_setting('default_transaction_read_only') AS "readOnly"`;
      expect(session?.readOnly).toBe('on');
      await expect(client`INSERT INTO users (id, email) VALUES (${`${marker}-write`}, 'x')`).rejects.toMatchObject({
        code: '25006',
      });
    } finally {
      await client.end({ timeout: 5 });
    }
    const collected = await collectDirectly();
    expect(collected.snapshot).toMatchObject({ readOnly: true, isolation: 'repeatable read', target: 'primary' });
  });

  it('sends no user ID or address as a bind parameter: every parameter is a numeric constant', async () => {
    const queries: string[] = [];
    const parameters: unknown[] = [];
    const client = postgres({
      ...accountEmailEvidenceConnectionOptions(databaseUrl, 'false'),
      debug: (_connection: number, query: string, queryParameters: unknown[]) => {
        queries.push(query);
        parameters.push(...queryParameters);
      },
    });
    let collected: CollectedEvidence;
    try {
      collected = await collectAccountEmailEvidence(client, { allowPrimary: true });
    } finally {
      await client.end({ timeout: 5 });
    }
    expect(collected.members.size).toBe(66);
    // Twenty-odd named reads plus one count per referencing column.
    expect(queries.length).toBeGreaterThan(collected.referencingColumns.length + 15);
    expect(parameters.length).toBeGreaterThan(0);
    for (const parameter of parameters) expect(String(parameter)).toMatch(/^[0-9]+$/);
    expectNoPrivateData(queries.join('\n'), { sqlText: true });
  });

  it('mutation check: dropping an own-data exclusion changes the audit-shaped counts', async () => {
    const collected = await collectDirectly();
    const baseline = buildAccountEmailEvidence(collected).summary;
    expect(baseline.groupsByKind).toEqual({ A: 17, B: 3, C: 5, D: 5, E: 0 });
    const withoutPercentiles = buildAccountEmailEvidence(collected, { ...OWN_DATA_RULES, derivedTables: [] }).summary;
    expect(withoutPercentiles.groupsByKind).toEqual({ A: 30, B: 0, C: 0, D: 0, E: 0 });
    expect(withoutPercentiles.contactEmails).toBe(30);
    for (const dropped of OWN_DATA_RULES.causedByOthers) {
      const rules = {
        ...OWN_DATA_RULES,
        causedByOthers: OWN_DATA_RULES.causedByOthers.filter((rule) => rule !== dropped),
      };
      expect(buildAccountEmailEvidence(collected, rules).summary.groupsByKind).not.toEqual(baseline.groupsByKind);
    }
    // The pending invite sits in a group that is kind A anyway, so it shows in the member count.
    const withInvites = buildAccountEmailEvidence(collected, { ...OWN_DATA_RULES, causedByOthersRows: [] }).summary;
    expect(withInvites.members.withOwnData).toBe(baseline.members.withOwnData + 1);
  });

  it('counts a new table and a new group automatically, and flags no-login and non-ASCII rows', async () => {
    // A brand-new table that references users: the C group's empty member now has data.
    await writer.unsafe('CREATE TABLE trip_reports (id bigserial PRIMARY KEY, author_id text REFERENCES users(id))');
    await writer`INSERT INTO trip_reports (author_id) VALUES (${firstGroupMemberIds[24]?.[1] ?? ''})`;
    // A new all-empty group: a Google-only member joined first, a password member second.
    await insertUser({
      id: `${marker}-e-0`,
      email: `empty.${marker}@example.test`,
      joined: at(1),
      providers: ['google'],
    });
    await insertUser({ id: `${marker}-e-1`, email: `EMPTY.${marker}@example.test`, joined: at(2), password: true });
    // A non-system user with no login, and a non-ASCII address.
    await insertUser({ id: `${marker}-nologin`, email: `nologin.${marker}@example.test`, joined: at(3) });
    const nonAscii = `İnan.${marker}@example.test`;
    await insertUser({ id: `${marker}-tr`, email: nonAscii, joined: at(4), password: true });
    // The test's own writer may send the address; the report never does.
    const [locale] = await writer<
      { lowered: string; twice: string }[]
    >`SELECT pg_catalog.lower(${nonAscii}) AS lowered, pg_catalog.lower(pg_catalog.lower(${nonAscii})) AS twice`;

    const out = join(outputDirectory, 'evidence-after-changes.json');
    const { exitCode, stdout, summary } = await runCli(['--out', out, '--allow-primary']);
    expect(exitCode).toBe(0);
    expectNoPrivateData(stdout);
    expect(summary).toMatchObject({
      groups: 31,
      groupsByKind: { A: 18, B: 3, C: 4, D: 5, E: 1 },
      contactEmails: 18,
      catalog: { referencingColumns: 28, ownDataColumns: 15 },
      login: { usersWithoutLoginMethod: 4, fixedSystemAccountsWithoutLogin: 3 },
      addresses: {
        nonAscii: 1,
        sqlLowerDiffersFromJs: locale?.lowered === nonAscii.toLowerCase() ? 0 : 1,
        normalizedFormsAtRiskInSqlCheck:
          locale?.lowered === nonAscii.toLowerCase() && locale?.twice === locale?.lowered ? 0 : 1,
      },
      checks: { kindsSumToGroups: true, noLoginRowsAreFixedSystemAccounts: false },
    });
    const worksheet = JSON.parse(readFileSync(out, 'utf8')) as EvidenceWorksheet;
    const emptyGroup = worksheet.groups.find((group) => group.kind === 'E');
    expect(emptyGroup?.proposal).toMatchObject({ keep: 'B', retireAddress: ['A'] });
    const promoted = worksheet.groups.find((group) =>
      group.members.some((member) => member.userId === firstGroupMemberIds[24]?.[1]),
    );
    expect(promoted?.kind).toBe('A');
    expect(promoted?.members[1]?.ownData.rows).toEqual({ 'public.trip_reports.author_id': 1 });
  });

  it('runs as a real CLI process with the same privacy boundary', () => {
    const out = join(outputDirectory, 'evidence-cli.json');
    const result = spawnSync(
      'vp',
      ['exec', 'tsx', 'packages/backend/src/scripts/account-email-evidence.ts', '--out', out, '--allow-primary'],
      {
        cwd: checkoutRoot,
        env: { ...process.env, ...evidenceEnvironment(), DATABASE_URL: 'postgresql://never-used@127.0.0.1:1/never' },
        encoding: 'utf8',
        timeout: 90000,
      },
    );
    expect(result.status).toBe(0);
    expectNoPrivateData(result.stdout);
    // stderr belongs to vp and tsx too, so it gets every check except the bare "@".
    expectNoPrivateData(result.stderr, { reportStdout: false });
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'complete', groups: 31 });
    expect(statSync(out).mode & 0o777).toBe(0o600);
  }, 120000);

  it('never falls back to DATABASE_URL and refuses DEBUG_SQL', async () => {
    const out = join(outputDirectory, 'never-written.json');
    const missing = await runCli(['--out', out], { DATABASE_URL: databaseUrl });
    expect(missing.summary).toMatchObject({ status: 'incomplete', code: 'CONFIGURATION' });
    const debug = await runCli(['--out', out], evidenceEnvironment({ DEBUG_SQL: 'true' }));
    expect(debug.summary).toMatchObject({ status: 'incomplete', code: 'CONFIGURATION' });
    expect(existsSync(out)).toBe(false);
    const unreachable = await runCli(['--out', out], {
      ACCOUNT_EMAIL_EVIDENCE_DATABASE_URL: `postgresql://private-user:${secretCanary}@127.0.0.1:1/private-database`,
    });
    expect(unreachable.summary).toMatchObject({ status: 'incomplete', code: 'SNAPSHOT_UNAVAILABLE' });
    expect(unreachable.stdout).not.toMatch(/private-user|private-database|postgresql:/);
    expectNoPrivateData(unreachable.stdout);
  });
});

describe('evidence arguments and worksheet path', () => {
  it('takes only --out and --allow-primary, never a URL', () => {
    expect(parseAccountEmailEvidenceArguments(['--out', 'a.json'])).toEqual({ out: 'a.json', allowPrimary: false });
    expect(parseAccountEmailEvidenceArguments(['--allow-primary', '--out', 'a.json'])).toEqual({
      out: 'a.json',
      allowPrimary: true,
    });
    for (const arguments_ of [
      [],
      ['--out'],
      ['--out', '--allow-primary'],
      ['--out', 'a.json', '--out', 'b.json'],
      ['--out', 'a.json', 'postgresql://secret@db/x'],
      ['--database-url', 'postgresql://secret@db/x', '--out', 'a.json'],
      ['--out', 'a.json', '--apply'],
    ])
      expect(() => parseAccountEmailEvidenceArguments(arguments_)).toThrow(
        expect.objectContaining({ code: 'CONFIGURATION' }),
      );
  });

  it('refuses a folder inside any git repository or worktree, including a sibling worktree', () => {
    for (const inside of [join(checkoutRoot, 'evidence.json'), join(checkoutRoot, 'packages', 'x.json')])
      expect(() => resolveWorksheetPath(inside)).toThrow(expect.objectContaining({ code: 'OUTPUT_INSIDE_REPOSITORY' }));
    // A sibling worktree marks itself with a `.git` file; a clone with a `.git` folder, further up.
    const worktree = join(outputDirectory, 'sibling-worktree');
    mkdirSync(join(worktree, 'private'), { recursive: true, mode: 0o700 });
    writeFileSync(join(worktree, '.git'), 'gitdir: /nowhere\n', { flag: 'wx' });
    expect(() => resolveWorksheetPath(join(worktree, 'private', 'x.json'))).toThrow(
      expect.objectContaining({ code: 'OUTPUT_INSIDE_REPOSITORY' }),
    );
    const clone = join(outputDirectory, 'clone');
    mkdirSync(join(clone, '.git'), { recursive: true });
    mkdirSync(join(clone, 'a', 'b'), { recursive: true, mode: 0o700 });
    expect(() => resolveWorksheetPath(join(clone, 'a', 'b', 'x.json'))).toThrow(
      expect.objectContaining({ code: 'OUTPUT_INSIDE_REPOSITORY' }),
    );
  });

  it('requires a 0700 folder, refuses an existing path and a missing folder', () => {
    const open = join(outputDirectory, 'open-folder');
    mkdirSync(open);
    chmodSync(open, 0o755);
    expect(() => resolveWorksheetPath(join(open, 'x.json'))).toThrow(
      expect.objectContaining({ code: 'OUTPUT_FOLDER_NOT_PRIVATE' }),
    );
    chmodSync(open, 0o700);
    expect(resolveWorksheetPath(join(open, 'x.json'))).toMatch(/x\.json$/);
    const existing = join(outputDirectory, 'path-exists.json');
    writeFileSync(existing, '', { flag: 'wx', mode: 0o600 });
    expect(() => resolveWorksheetPath(existing)).toThrow(expect.objectContaining({ code: 'OUTPUT_EXISTS' }));
    expect(() => resolveWorksheetPath(join(outputDirectory, 'missing', 'x.json'))).toThrow(
      expect.objectContaining({ code: 'OUTPUT_UNAVAILABLE' }),
    );
  });

  it('removes a partial worksheet on failure, so a rerun can use the same path', () => {
    const out = join(outputDirectory, 'over-limit.json');
    const worksheet = { formatVersion: 1, note: 'x'.repeat(64) } as unknown as EvidenceWorksheet;
    expect(() => writeEvidenceWorksheet(out, worksheet, 16)).toThrow(expect.objectContaining({ code: 'INPUT_LIMIT' }));
    expect(existsSync(out)).toBe(false);
    const written = writeEvidenceWorksheet(out, worksheet);
    expect(written.bytes).toBe(readFileSync(out).length);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    // A path that already existed is refused and never removed.
    expect(() => writeEvidenceWorksheet(out, worksheet)).toThrow(expect.objectContaining({ code: 'OUTPUT_EXISTS' }));
    expect(existsSync(out)).toBe(true);
  });
});
