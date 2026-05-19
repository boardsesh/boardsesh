/**
 * Integration tests for the shared-playlist gate on queue mutations.
 *
 * The new default for sessions is `shared_playlist_enabled = false`. When
 * off, queue mutations are rejected server-side with a typed
 * SHARED_PLAYLIST_DISABLED error so clients can fall back to writing to
 * IndexedDB cleanly. When on, the existing behaviour is preserved.
 */

import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import type { ConnectionContext, ClimbQueueItem } from '@boardsesh/shared-schema';
import { GraphQLError } from 'graphql';
import { db } from '../db/client';
import { queueMutations } from '../graphql/resolvers/queue/mutations';

const USER_ID = 'user-queue-gating-test';

function authedCtxForSession(sessionId: string, userId = USER_ID): ConnectionContext {
  return {
    connectionId: `http-${userId}-${sessionId.slice(0, 8)}`,
    isAuthenticated: true,
    userId,
    sessionId,
  };
}

function makeClimbItem(label: string): ClimbQueueItem {
  return {
    uuid: uuidv4(),
    climb: {
      uuid: `climb-${label}`,
      setter_username: 'tester',
      name: `Test ${label}`,
      description: '',
      frames: 'p100r12',
      frames_count: 1,
      frames_pace: 0,
      angle: 40,
      // Cast through unknown to keep the test fixture small — the resolver
      // path under test doesn't read these fields, it just round-trips the
      // payload.
    } as unknown as ClimbQueueItem['climb'],
  };
}

async function seedTestUser(): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, name, created_at, updated_at)
    VALUES (${USER_ID}, ${`${USER_ID}@test.com`}, ${`User ${USER_ID}`}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
}

async function createSession(opts: { sharedPlaylistEnabled: boolean }): Promise<string> {
  const sessionId = `session-${uuidv4().slice(0, 12)}`;
  await db.execute(sql`
    INSERT INTO board_sessions (id, board_path, shared_playlist_enabled, started_at, created_at, last_activity)
    VALUES (
      ${sessionId},
      ${'kilter/1/2/3/40'},
      ${opts.sharedPlaylistEnabled},
      now(),
      now(),
      now()
    )
  `);
  return sessionId;
}

describe('queue mutations — shared_playlist_enabled gate', () => {
  beforeEach(async () => {
    await seedTestUser();
  });

  it('addQueueItem throws SHARED_PLAYLIST_DISABLED when the flag is false', async () => {
    const sessionId = await createSession({ sharedPlaylistEnabled: false });
    const item = makeClimbItem('disabled');
    const ctx = authedCtxForSession(sessionId);

    let caught: unknown;
    try {
      await queueMutations.addQueueItem(undefined, { item }, ctx);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(GraphQLError);
    const gqlErr = caught as GraphQLError;
    expect(gqlErr.extensions?.code).toBe('SHARED_PLAYLIST_DISABLED');
    expect(gqlErr.message).toMatch(/Shared playlist is disabled/);
  });

  it('addQueueItem succeeds when shared_playlist_enabled = true', async () => {
    const sessionId = await createSession({ sharedPlaylistEnabled: true });
    const item = makeClimbItem('enabled');
    const ctx = authedCtxForSession(sessionId);

    const result = await queueMutations.addQueueItem(undefined, { item }, ctx);
    expect(result.uuid).toBe(item.uuid);
  });

  it('removeQueueItem also gates on the flag', async () => {
    const sessionId = await createSession({ sharedPlaylistEnabled: false });
    const ctx = authedCtxForSession(sessionId);

    let caught: unknown;
    try {
      await queueMutations.removeQueueItem(undefined, { uuid: 'some-uuid' }, ctx);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(GraphQLError);
    expect((caught as GraphQLError).extensions?.code).toBe('SHARED_PLAYLIST_DISABLED');
  });

  it('setQueue also gates on the flag', async () => {
    const sessionId = await createSession({ sharedPlaylistEnabled: false });
    const ctx = authedCtxForSession(sessionId);

    let caught: unknown;
    try {
      await queueMutations.setQueue(undefined, { queue: [], currentClimbQueueItem: undefined }, ctx);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(GraphQLError);
    expect((caught as GraphQLError).extensions?.code).toBe('SHARED_PLAYLIST_DISABLED');
  });
});
