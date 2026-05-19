/**
 * Regression test for the SharedPlaylistToggled broadcast.
 *
 * PR #2219 review caught that `setSharedPlaylistEnabled` only persisted to
 * Postgres — peers in the session never received a SessionEvent push, so
 * they kept hitting the WS queue mutations (rejected with
 * SHARED_PLAYLIST_DISABLED) after the leader disabled the toggle, or stayed
 * stuck in local-only mode after the leader enabled it.
 *
 * The fix publishes a `SharedPlaylistToggled` SessionEvent from the
 * resolver. This test pins the contract: after a successful toggle, the
 * pubsub bus sees a `SharedPlaylistToggled` event with the correct
 * sessionId and new value.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import type { ConnectionContext, SessionEvent } from '@boardsesh/shared-schema';
import type { SharedPlaylistToggled } from '@boardsesh/shared-schema/generated';
import { db } from '../db/client';
import { boardHistoryMutations } from '../graphql/resolvers/board-history/mutations';
import { pubsub } from '../pubsub/index';
import { roomManager } from '../services/room-manager';

const USER_ID = 'user-set-shared-broadcast-1';

function httpCtx(userId = USER_ID, connectionId?: string): ConnectionContext {
  return {
    connectionId: connectionId ?? `http-${userId}-${Math.random().toString(36).slice(2, 8)}`,
    isAuthenticated: true,
    userId,
    transport: 'http',
  };
}

async function seedTestUser(userId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, name, created_at, updated_at)
    VALUES (${userId}, ${`${userId}@test.com`}, ${`User ${userId}`}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
}

async function createSession(opts: { sharedPlaylistEnabled: boolean; createdByUserId: string }): Promise<string> {
  const sessionId = `session-${uuidv4().slice(0, 12)}`;
  await db.execute(sql`
    INSERT INTO board_sessions (id, board_path, shared_playlist_enabled, created_by_user_id, started_at, created_at, last_activity)
    VALUES (
      ${sessionId},
      ${'kilter/1/2/3/40'},
      ${opts.sharedPlaylistEnabled},
      ${opts.createdByUserId},
      now(),
      now(),
      now()
    )
  `);
  return sessionId;
}

describe('setSharedPlaylistEnabled — broadcast', () => {
  let publishSpy: ReturnType<typeof vi.spyOn>;
  let leaderConnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    publishSpy = vi.spyOn(pubsub, 'publishSessionEvent').mockImplementation(() => {});
    // Default to "no current leader" — the creator-path auth check passes
    // for our owned session below, so this default is safe.
    leaderConnSpy = vi.spyOn(roomManager, 'getSessionLeaderConnectionId').mockResolvedValue(null);
    await seedTestUser(USER_ID);
  });

  afterEach(() => {
    publishSpy.mockRestore();
    leaderConnSpy.mockRestore();
  });

  it('publishes SharedPlaylistToggled after disabling on a creator-owned session', async () => {
    const sessionId = await createSession({ sharedPlaylistEnabled: true, createdByUserId: USER_ID });

    const result = await boardHistoryMutations.setSharedPlaylistEnabled(
      undefined,
      { sessionId, enabled: false },
      httpCtx(),
    );

    expect(result.sharedPlaylistEnabled).toBe(false);

    expect(publishSpy).toHaveBeenCalledTimes(1);
    const [publishedSessionId, publishedEvent] = publishSpy.mock.calls[0] as [string, SessionEvent];
    expect(publishedSessionId).toBe(sessionId);
    expect(publishedEvent.__typename).toBe('SharedPlaylistToggled');
    // Generated SessionEvent union uses optional `__typename?`, so the
    // `Extract<…>` trick resolves to `never`. Reference the generated
    // concrete type directly instead (matches the pattern in
    // event-processor-session-cache.test.ts).
    const toggled = publishedEvent as SharedPlaylistToggled;
    expect(toggled.sessionId).toBe(sessionId);
    expect(toggled.enabled).toBe(false);
  });

  it('publishes SharedPlaylistToggled after enabling on a creator-owned session', async () => {
    const sessionId = await createSession({ sharedPlaylistEnabled: false, createdByUserId: USER_ID });

    const result = await boardHistoryMutations.setSharedPlaylistEnabled(
      undefined,
      { sessionId, enabled: true },
      httpCtx(),
    );

    expect(result.sharedPlaylistEnabled).toBe(true);

    expect(publishSpy).toHaveBeenCalledTimes(1);
    const [publishedSessionId, publishedEvent] = publishSpy.mock.calls[0] as [string, SessionEvent];
    expect(publishedSessionId).toBe(sessionId);
    expect(publishedEvent.__typename).toBe('SharedPlaylistToggled');
    const toggled = publishedEvent as SharedPlaylistToggled;
    expect(toggled.enabled).toBe(true);
  });

  it('does not publish when the caller is denied (no leader and not the creator)', async () => {
    const otherUserId = 'user-set-shared-broadcast-2';
    await seedTestUser(otherUserId);
    const sessionId = await createSession({ sharedPlaylistEnabled: true, createdByUserId: otherUserId });

    await expect(
      boardHistoryMutations.setSharedPlaylistEnabled(undefined, { sessionId, enabled: false }, httpCtx()),
    ).rejects.toThrow();

    expect(publishSpy).not.toHaveBeenCalled();
  });
});
