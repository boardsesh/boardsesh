import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { boardSessions } from '@boardsesh/db/schema/app';
import { getWorkerDatabaseName } from '../../../../__tests__/worker-db';
import { resolveConsolidatedSessionAddress, rejectConsolidatedSessionEdit } from '../consolidation-alias';
import {
  retargetConsolidatedSessionAliases,
  tombstoneConsolidatedSessionAliases,
} from '../../../../auth/account-consolidation/session-alias-store';

const databaseName = getWorkerDatabaseName('bs_consolidation_sessions');
const adminUrl = (process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/postgres').replace(
  /\/[^/]+$/,
  '/postgres',
);
let admin: postgres.Sql;
let client: postgres.Sql;
let created = false;

describe('owner-scoped consolidated session addresses', () => {
  beforeAll(async () => {
    admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    created = true;
    client = postgres(adminUrl.replace(/\/[^/]+$/, `/${databaseName}`), { max: 1, onnotice: () => {} });
    await client.unsafe(`CREATE TABLE board_sessions(id text PRIMARY KEY,created_by_user_id text,origin text);
      CREATE TABLE account_consolidation_session_aliases(retired_session_id text PRIMARY KEY,canonical_session_id text,target_user_id text NOT NULL,merge_id text NOT NULL,tombstoned boolean NOT NULL DEFAULT false);
      INSERT INTO board_sessions VALUES('canonical','owner','inferred'),('next','owner','inferred'),('foreign','stranger','inferred'),('party','owner','explicit');
      INSERT INTO account_consolidation_session_aliases VALUES('old','canonical','owner','merge',false),('other-owner','foreign','owner','merge',false),('explicit-alias','party','owner','merge',false),('dangling','missing','owner','merge',false);`);
    await client.unsafe(
      `ALTER TABLE board_sessions ADD COLUMN name text, ADD COLUMN goal text, ADD COLUMN notes text, ADD COLUMN user_edited boolean DEFAULT false`,
    );
    for (const tableName of ['comments', 'votes', 'vote_counts', 'feed_items', 'notifications', 'content_privacy'])
      await client.unsafe(`CREATE TABLE ${tableName}(entity_type text,entity_id text)`);
    for (const tableName of [
      'board_session_participants',
      'session_health_kit_workouts',
      'session_boards',
      'board_session_queues',
      'session_workouts',
      'integration_exports',
      'board_climb_events',
    ])
      await client.unsafe(`CREATE TABLE ${tableName}(session_id text)`);
    for (const tableName of ['resource_privacy', 'resource_grants'])
      await client.unsafe(`CREATE TABLE ${tableName}(kind text,resource_id text)`);
  });
  afterAll(async () => {
    await client?.end({ timeout: 1 });
    if (created) await admin.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await admin?.end({ timeout: 1 });
  });

  it('routes the old inferred address only for its authenticated canonical owner', async () => {
    expect(await resolveConsolidatedSessionAddress(drizzle(client), 'old', 'owner')).toBe('canonical');
    expect(await resolveConsolidatedSessionAddress(drizzle(client), 'old', 'stranger')).toBeNull();
    expect(await resolveConsolidatedSessionAddress(drizzle(client), 'old', null)).toBeNull();
  });
  it('leaves ordinary explicit session addresses available to their existing permission checks', async () => {
    expect(await resolveConsolidatedSessionAddress(drizzle(client), 'party', 'stranger')).toBe('party');
    await expect(rejectConsolidatedSessionEdit(drizzle(client), 'party', 'owner')).resolves.toBeUndefined();
  });
  it('rejects dangling aliases, changed owners and unexpected explicit targets', async () => {
    for (const address of ['dangling', 'other-owner', 'explicit-alias'])
      expect(await resolveConsolidatedSessionAddress(drizzle(client), address, 'owner')).toBeNull();
  });
  it('refuses old full-document edits and external workout mapping writes', async () => {
    await expect(rejectConsolidatedSessionEdit(drizzle(client), 'old', 'owner')).rejects.toMatchObject({
      extensions: { code: 'CONFLICT' },
    });
    await expect(rejectConsolidatedSessionEdit(drizzle(client), 'old', 'stranger')).rejects.toMatchObject({
      extensions: { code: 'NOT_FOUND' },
    });
  });
  it('rolls back attempted reconciliation into explicit sessions or from a changed owner', async () => {
    const before = await client`SELECT * FROM account_consolidation_session_aliases ORDER BY retired_session_id`;
    for (const [fromId, toId] of [
      ['canonical', 'party'],
      ['foreign', 'next'],
    ]) {
      await expect(
        drizzle(client).transaction(async (tx) => {
          // Represents the tick write performed before reconciliation in its shared transaction.
          await tx
            .insert(boardSessions)
            .values({ id: 'tentative-write', createdByUserId: 'owner', origin: 'inferred' });
          await retargetConsolidatedSessionAliases(tx, fromId, toId, 'owner');
        }),
      ).rejects.toThrow();
      expect(await client`SELECT id FROM board_sessions WHERE id='tentative-write'`).toEqual([]);
      expect(await client`SELECT * FROM account_consolidation_session_aliases ORDER BY retired_session_id`).toEqual(
        before,
      );
    }
  });
  it('rolls back later merges and emptied-session deletion when combined notes or social history remain', async () => {
    for (const feature of ['notes', 'social']) {
      if (feature === 'notes')
        await client`UPDATE board_sessions SET notes='combined source notes' WHERE id='canonical'`;
      else await client`INSERT INTO feed_items VALUES('session','canonical')`;
      for (const operation of ['merge', 'empty']) {
        await expect(
          drizzle(client).transaction(async (tx) => {
            await tx
              .insert(boardSessions)
              .values({ id: 'tentative-write', createdByUserId: 'owner', origin: 'inferred' });
            if (operation === 'merge') await retargetConsolidatedSessionAliases(tx, 'canonical', 'next', 'owner');
            else await tombstoneConsolidatedSessionAliases(tx, ['canonical'], 'owner');
          }),
        ).rejects.toThrow();
        expect(await client`SELECT id FROM board_sessions WHERE id='tentative-write'`).toEqual([]);
        expect(await resolveConsolidatedSessionAddress(drizzle(client), 'old', 'owner')).toBe('canonical');
      }
      await client`UPDATE board_sessions SET notes=NULL WHERE id='canonical'`;
      await client`DELETE FROM feed_items`;
    }
  });
  it('retargets existing routing in the same transaction as a later ordinary merge', async () => {
    await drizzle(client).transaction(async (tx) => {
      await retargetConsolidatedSessionAliases(tx, 'canonical', 'next', 'owner');
      await tx.delete(boardSessions).where(eq(boardSessions.id, 'canonical'));
    });
    expect(await resolveConsolidatedSessionAddress(drizzle(client), 'old', 'owner')).toBe('next');
    expect(await resolveConsolidatedSessionAddress(drizzle(client), 'canonical', 'owner')).toBe('next');
  });
  it('preserves the exact alias state when a later merge rolls back', async () => {
    await client`INSERT INTO board_sessions(id,created_by_user_id,origin) VALUES('rollback','owner','inferred')`;
    const before = await client`SELECT * FROM account_consolidation_session_aliases ORDER BY retired_session_id`;
    await expect(
      drizzle(client).transaction(async (tx) => {
        await retargetConsolidatedSessionAliases(tx, 'next', 'rollback', 'owner');
        throw new Error('synthetic rollback');
      }),
    ).rejects.toThrow('synthetic rollback');
    expect(await client`SELECT * FROM account_consolidation_session_aliases ORDER BY retired_session_id`).toEqual(
      before,
    );
  });
  it('tombstones known addresses when their inferred destination is emptied', async () => {
    await drizzle(client).transaction((tx) => tombstoneConsolidatedSessionAliases(tx, ['next'], 'owner'));
    expect(await resolveConsolidatedSessionAddress(drizzle(client), 'old', 'owner')).toBeNull();
    expect(
      await client`SELECT tombstoned,canonical_session_id FROM account_consolidation_session_aliases WHERE retired_session_id='old'`,
    ).toEqual([{ tombstoned: true, canonical_session_id: null }]);
  });
});
