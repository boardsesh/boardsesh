import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import postgres from 'postgres';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { getWorkerDatabaseName } from '../../../__tests__/worker-db';
import { FIXED_SYSTEM_ACCOUNT_IDS } from '../evidence';
import { collectAccountEmailEvidenceWith } from '../evidence-snapshot';
import { runAccountEmailMergePreviewCli } from '../../../scripts/account-email-merge-preview';
import { collectAccountEmailMergePreview, mergeIndexCollisionQuery } from '../merge-snapshot';

const adminUrl = (
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/boardsesh_backend_test'
).replace(/\/[^/]+$/, '/postgres');
const databaseName = getWorkerDatabaseName('bs_merge_snapshot');
const databaseUrl = adminUrl.replace(/\/[^/]+$/, `/${databaseName}`);
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

ALTER TABLE boardsesh_ticks ADD COLUMN board_type text NOT NULL DEFAULT 'kilter';
ALTER TABLE boardsesh_ticks ADD COLUMN climb_uuid text NOT NULL DEFAULT 'climb';
ALTER TABLE boardsesh_ticks ADD COLUMN angle integer NOT NULL DEFAULT 40;
CREATE TABLE user_board_mappings (user_id text NOT NULL REFERENCES users(id), board_type text NOT NULL,
  board_user_id integer, board_user_id_text text, UNIQUE(user_id, board_type));
CREATE TABLE merge_favorites (user_id text NOT NULL REFERENCES users(id), resource text NOT NULL, angle integer,
  UNIQUE(user_id, resource, angle));
CREATE TABLE merge_nulls_not_distinct (user_id text NOT NULL REFERENCES users(id), resource text NOT NULL, angle integer,
  UNIQUE NULLS NOT DISTINCT(user_id, resource, angle));
CREATE UNIQUE INDEX merge_follows_unique ON user_follows(follower_id, following_id);
CREATE TABLE merge_special (user_id text NOT NULL REFERENCES users(id), resource text NOT NULL, enabled boolean NOT NULL DEFAULT true);
CREATE UNIQUE INDEX merge_expression ON merge_special(user_id, lower(resource));
CREATE UNIQUE INDEX merge_partial ON merge_special(user_id, resource) WHERE enabled;
CREATE UNIQUE INDEX merge_include ON merge_special(resource) INCLUDE(user_id);
CREATE UNIQUE INDEX merge_pattern_ops ON merge_special(user_id text_pattern_ops, resource);
CREATE UNIQUE INDEX merge_collation ON merge_special(user_id COLLATE "C", resource);
CREATE UNIQUE INDEX merge_secret ON user_credentials(user_id, password_hash);
`;

let admin: postgres.Sql;
let client: postgres.Sql;
let created = false;

describe('read-only account merge snapshot', () => {
  beforeAll(async () => {
    admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    created = true;
    client = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    await client.unsafe(SCHEMA);
    await client`INSERT INTO users(id,email,name) VALUES ('first','Case@example.test','First-private-merge-7430'), ('second','case@example.test','Second-private-merge-7430'), ('outsider','other@example.test','Other')`;
    await client`INSERT INTO user_credentials(user_id,password_hash) VALUES ('first','secret-canary-not-a-hash'), ('second','secret-canary-not-a-hash')`;
    await client`INSERT INTO user_credentials(user_id,password_hash) VALUES ('outsider','secret-canary-not-a-hash')`;
    for (const [index, userId] of FIXED_SYSTEM_ACCOUNT_IDS.entries())
      await client`INSERT INTO users(id,email) VALUES (${userId},${`system-${index}@example.test`})`;
    await client`INSERT INTO user_profiles(user_id,display_name) VALUES ('first','First-private-merge-7430'),('second','Second-private-merge-7430')`;
    await client`INSERT INTO merge_favorites(user_id,resource,angle) VALUES ('first','shared',NULL),('second','shared',NULL),('first','shared',40),('second','shared',40)`;
    await client`INSERT INTO merge_nulls_not_distinct SELECT * FROM merge_favorites`;
    await client`INSERT INTO user_follows(follower_id,following_id) VALUES ('first','first'),('first','second'),('second','first'),('second','second'),('first','outsider'),('second','outsider')`;
    await client`INSERT INTO user_board_mappings(user_id,board_type,board_user_id) VALUES ('first','kilter',42),('second','kilter',42),('first','tension',1),('second','tension',2)`;
    await client`INSERT INTO boardsesh_ticks(user_id,climbed_at) VALUES ('first','2026-11-11 12:00:00'),('second','2026-11-11 12:00:00'),('first','2026-11-11 13:00:00'),('first','2026-11-11 13:00:00')`;
  });
  afterAll(async () => {
    await client?.end({ timeout: 1 });
    if (created) await admin.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await admin?.end({ timeout: 1 });
  });

  it('projects both relationship endpoints and keeps outsider endpoints', async () => {
    const counted = await drizzle(client).execute(
      mergeIndexCollisionQuery({
        schema: 'public',
        table: 'user_follows',
        columns: ['follower_id', 'following_id'],
        userColumns: ['follower_id', 'following_id'],
        nullsNotDistinct: false,
      }),
    );
    expect(counted).toEqual([{ address: 'case@example.test', duplicateKeys: '2', rows: '6' }]);
  });

  it('counts NULLS DISTINCT and NULLS NOT DISTINCT according to the index', async () => {
    const distinct = await drizzle(client).execute(
      mergeIndexCollisionQuery({
        schema: 'public',
        table: 'merge_favorites',
        columns: ['user_id', 'resource', 'angle'],
        userColumns: ['user_id'],
        nullsNotDistinct: false,
      }),
    );
    const notDistinct = await drizzle(client).execute(
      mergeIndexCollisionQuery({
        schema: 'public',
        table: 'merge_nulls_not_distinct',
        columns: ['user_id', 'resource', 'angle'],
        userColumns: ['user_id'],
        nullsNotDistinct: true,
      }),
    );
    expect(distinct).toEqual([{ address: 'case@example.test', duplicateKeys: '1', rows: '2' }]);
    expect(notDistinct).toEqual([{ address: 'case@example.test', duplicateKeys: '2', rows: '4' }]);
  });

  it('keeps companion reads in the enforced read-only transaction', async () => {
    let writeCode: unknown;
    await expect(
      collectAccountEmailEvidenceWith(client, { allowPrimary: true }, async (transaction) => {
        try {
          await transaction.execute(
            sql`INSERT INTO public.users(id,email) VALUES ('write-probe','write-probe@example.test')`,
          );
        } catch (error) {
          if (
            error instanceof Error &&
            'cause' in error &&
            typeof error.cause === 'object' &&
            error.cause !== null &&
            'code' in error.cause
          )
            writeCode = error.cause.code;
          throw error;
        }
      }),
    ).rejects.toMatchObject({ code: 'SNAPSHOT_UNAVAILABLE' });
    expect(writeCode).toBe('25006');
    expect(await client`SELECT count(*)::integer AS total FROM users`).toEqual([{ total: 6 }]);
  });

  it('writes a private checksummed preview with counts-only CLI output', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'boardsesh-merge-preview-cli-'));
    chmodSync(directory, 0o700);
    const out = join(directory, 'preview.json');
    let output = '';
    const exitCode = await runAccountEmailMergePreviewCli(
      ['--out', out, '--allow-primary'],
      { ACCOUNT_EMAIL_MERGE_PREVIEW_DATABASE_URL: databaseUrl },
      (text) => {
        output += text;
      },
    );
    expect(exitCode, output).toBe(0);
    const receipt = JSON.parse(output) as {
      status: string;
      connectionClosed: boolean;
      readyToMerge: number;
      worksheet: { sha256: string; bytes: number };
    };
    expect(receipt.status).toBe('complete');
    expect(receipt.connectionClosed).toBe(true);
    expect(receipt.readyToMerge).toBe(0);
    const bytes = readFileSync(out);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(receipt.worksheet.sha256);
    expect(bytes.length).toBe(receipt.worksheet.bytes);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(bytes.toString()).toContain('case@example.test');
    for (const privateText of [
      'case@example.test',
      'Case@example.test',
      'First-private-merge-7430',
      'Second-private-merge-7430',
      'secret-canary',
      'outsider',
      out,
    ])
      expect(output).not.toContain(privateText);
    expect(await client`SELECT count(*)::integer AS total FROM users`).toEqual([{ total: 6 }]);
  });

  it('collects all facts in the guarded snapshot and flags unsupported indexes', async () => {
    const preview = await collectAccountEmailMergePreview(client, { allowPrimary: true });
    expect(preview.evidence.snapshot.readOnly).toBe(true);
    expect(preview.evidence.members.size).toBe(2);
    expect(preview.conflicts.tickCandidates).toEqual([{ address: 'case@example.test', duplicateKeys: 1, rows: 2 }]);
    expect(preview.conflicts.boardMappings).toEqual([
      { address: 'case@example.test', boardType: 'kilter', accounts: 2, distinctUpstreamIdentities: 1 },
      { address: 'case@example.test', boardType: 'tension', accounts: 2, distinctUpstreamIdentities: 2 },
    ]);
    const byIndex = new Map(preview.conflicts.uniqueIndexes.map((index) => [index.index, index]));
    expect(byIndex.get('merge_expression')?.analysis).toBe('unsupported');
    expect(byIndex.get('merge_partial')?.analysis).toBe('unsupported');
    expect(byIndex.has('merge_include')).toBe(false);
    expect(byIndex.get('merge_pattern_ops')?.analysis).toBe('unsupported');
    expect(byIndex.get('merge_collation')?.analysis).toBe('unsupported');
    expect(byIndex.get('merge_secret')?.reason).toContain('Sensitive');
    expect(byIndex.get('merge_follows_unique')?.collisions).toEqual([
      { address: 'case@example.test', duplicateKeys: 2, rows: 6 },
    ]);
    expect(JSON.stringify(preview)).not.toContain('secret-canary');
    expect(preview.conflicts.limitations.some((limitation) => limitation.includes('Check constraints'))).toBe(true);
    expect(await client`SELECT count(*)::integer AS total FROM users`).toEqual([{ total: 6 }]);
    expect(await client`SELECT count(*)::integer AS total FROM user_follows`).toEqual([{ total: 6 }]);
  });
});
