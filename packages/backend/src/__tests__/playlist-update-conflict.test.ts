import { describe, it, expect, beforeEach, afterAll } from 'vite-plus/test';
import { eq, sql } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { PLAYLIST_UPDATE_CONFLICT_CODE } from '@boardsesh/shared-schema';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { playlistMutations } from '../graphql/resolvers/playlists/mutations';
import {
  detectPlaylistUpdateConflict,
  normalizePlaylistText,
} from '../graphql/resolvers/playlists/helpers/update-conflict';

// #1934: updatePlaylist is the one offline-replayable mutation that can't be
// auto-merged, so it takes an optional `basedOn` snapshot and refuses a genuine
// collision instead of quietly keeping whichever write landed last.

describe('detectPlaylistUpdateConflict', () => {
  const storedAt = new Date('2026-08-10T12:00:00.000Z');
  const olderSnapshot = '2026-08-10T11:00:00.000Z';

  function stored(overrides: Record<string, unknown> = {}) {
    return {
      name: 'Crimps',
      description: null,
      isPublic: false,
      color: null,
      icon: null,
      updatedAt: storedAt,
      ...overrides,
    };
  }

  it('never conflicts without a basedOn snapshot (blind last-write-wins stays the default)', () => {
    expect(
      detectPlaylistUpdateConflict({
        stored: stored({ name: 'Renamed elsewhere' }),
        incoming: { name: 'Mine' },
      }),
    ).toBe(false);
  });

  it('applies when the snapshot is as new as the stored row', () => {
    expect(
      detectPlaylistUpdateConflict({
        stored: stored(),
        incoming: { name: 'Mine' },
        basedOn: { updatedAt: storedAt.toISOString(), name: 'Crimps' },
      }),
    ).toBe(false);
  });

  it('conflicts when someone else renamed the playlist', () => {
    expect(
      detectPlaylistUpdateConflict({
        stored: stored({ name: 'Renamed elsewhere' }),
        incoming: { name: 'Mine' },
        basedOn: { updatedAt: olderSnapshot, name: 'Crimps' },
      }),
    ).toBe(true);
  });

  it('does not conflict when only the timestamp moved (a climb was added)', () => {
    // addClimbToPlaylist/remove/reorder all bump playlists.updated_at, so a bare
    // timestamp comparison would cry conflict on every climb add.
    expect(
      detectPlaylistUpdateConflict({
        stored: stored(),
        incoming: { name: 'Mine' },
        basedOn: { updatedAt: olderSnapshot, name: 'Crimps' },
      }),
    ).toBe(false);
  });

  it('treats an already-applied edit as a no-op success, not a conflict', () => {
    expect(
      detectPlaylistUpdateConflict({
        stored: stored({ name: 'Mine' }),
        incoming: { name: 'Mine' },
        basedOn: { updatedAt: olderSnapshot, name: 'Crimps' },
      }),
    ).toBe(false);
  });

  it("treats '' and null as the same value for description/colour/icon", () => {
    expect(normalizePlaylistText('')).toBeNull();
    expect(normalizePlaylistText(null)).toBeNull();
    expect(normalizePlaylistText(undefined)).toBeUndefined();
    expect(normalizePlaylistText('#123456')).toBe('#123456');

    expect(
      detectPlaylistUpdateConflict({
        stored: stored({ description: null, color: null }),
        incoming: { description: '', color: '' },
        basedOn: { updatedAt: olderSnapshot, description: '', color: '' },
      }),
    ).toBe(false);
  });

  it('conflicts on a colour or icon someone else changed, same as a rename', () => {
    // name/description/colour/icon share one loop; pin colour and icon so a
    // future field-list edit can't quietly drop them from the check.
    expect(
      detectPlaylistUpdateConflict({
        stored: stored({ color: '#1F2937' }),
        incoming: { color: '#6D28D9' },
        basedOn: { updatedAt: olderSnapshot, color: '#8C4A52' },
      }),
    ).toBe(true);

    expect(
      detectPlaylistUpdateConflict({
        stored: stored({ icon: '🪨' }),
        incoming: { icon: '💀' },
        basedOn: { updatedAt: olderSnapshot, icon: '🔥' },
      }),
    ).toBe(true);

    // ...and not when the other device set it to what this edit already sends.
    expect(
      detectPlaylistUpdateConflict({
        stored: stored({ color: '#6D28D9' }),
        incoming: { color: '#6D28D9' },
        basedOn: { updatedAt: olderSnapshot, color: '#8C4A52' },
      }),
    ).toBe(false);
  });

  it('treats a missing based-on field as divergent (conservative)', () => {
    expect(
      detectPlaylistUpdateConflict({
        stored: stored({ description: 'set elsewhere' }),
        incoming: { description: 'mine' },
        // No `description` in the snapshot: we can't prove the client saw the
        // stored value, so refuse rather than overwrite.
        basedOn: { updatedAt: olderSnapshot, name: 'Crimps' },
      }),
    ).toBe(true);
  });

  it('conflicts on visibility only when the client did not see the stored value', () => {
    expect(
      detectPlaylistUpdateConflict({
        stored: stored({ isPublic: true }),
        incoming: { isPublic: false },
        basedOn: { updatedAt: olderSnapshot, isPublic: true },
      }),
    ).toBe(false);

    expect(
      detectPlaylistUpdateConflict({
        stored: stored({ isPublic: true }),
        incoming: { isPublic: false },
        // isPublic absent from the snapshot.
        basedOn: { updatedAt: olderSnapshot, name: 'Crimps' },
      }),
    ).toBe(true);

    // An unknown snapshot value can't manufacture a conflict on its own: if the
    // stored visibility already equals what this edit sends, there is nothing to
    // decide between.
    expect(
      detectPlaylistUpdateConflict({
        stored: stored({ isPublic: true }),
        incoming: { isPublic: true },
        basedOn: { updatedAt: olderSnapshot, isPublic: null },
      }),
    ).toBe(false);
  });
});

const PLAYLIST_UUID = 'pl-conflict-1934';
const OWNER_ID = 'user-123'; // seeded by setup.ts

function makeCtx(): ConnectionContext {
  return {
    connectionId: 'conn-1',
    isAuthenticated: true,
    userId: OWNER_ID,
    sessionId: null,
    boardPath: null,
    controllerId: null,
    controllerApiKey: null,
  } as unknown as ConnectionContext;
}

// Read through drizzle (not raw `execute`) so `updated_at` arrives as the same
// Date the resolver compares against, rather than a driver string.
async function readPlaylist(): Promise<{ name: string; description: string | null; updatedAt: Date }> {
  const [row] = await db
    .select({
      name: dbSchema.playlists.name,
      description: dbSchema.playlists.description,
      updatedAt: dbSchema.playlists.updatedAt,
    })
    .from(dbSchema.playlists)
    .where(eq(dbSchema.playlists.id, 1n))
    .limit(1);
  return row;
}

describe('updatePlaylist — compare-and-swap against a real DB (#1934)', () => {
  // Playlist tables aren't in setup.ts's per-file reset list, so own the reset.
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE playlist_climbs, playlist_ownership, playlists RESTART IDENTITY CASCADE`);
    await db.execute(sql`
      INSERT INTO playlists (id, uuid, board_type, layout_id, name, is_public, created_at, updated_at)
      VALUES (1, ${PLAYLIST_UUID}, 'kilter', 1, 'Crimps', false, now() - interval '1 hour', now() - interval '1 hour')
    `);
    await db.execute(sql`INSERT INTO playlist_ownership (playlist_id, user_id) VALUES (1, ${OWNER_ID})`);
  });

  afterAll(async () => {
    await db.execute(sql`TRUNCATE TABLE playlist_climbs, playlist_ownership, playlists RESTART IDENTITY CASCADE`);
  });

  it('applies without a basedOn snapshot (unchanged behaviour for web and shipped binaries)', async () => {
    await playlistMutations.updatePlaylist(
      null,
      { input: { playlistId: PLAYLIST_UUID, name: 'Blind write' } },
      makeCtx(),
    );

    expect((await readPlaylist()).name).toBe('Blind write');
  });

  it('applies when the snapshot matches the stored updatedAt', async () => {
    const before = await readPlaylist();

    await playlistMutations.updatePlaylist(
      null,
      {
        input: {
          playlistId: PLAYLIST_UUID,
          name: 'Fresh edit',
          basedOn: { updatedAt: before.updatedAt.toISOString(), name: 'Crimps' },
        },
      },
      makeCtx(),
    );

    expect((await readPlaylist()).name).toBe('Fresh edit');
  });

  it('throws PLAYLIST_UPDATE_CONFLICT carrying the server values when another writer renamed it', async () => {
    const before = await readPlaylist();
    // Another device renames the playlist and sets a description.
    await db.execute(
      sql`UPDATE playlists SET name = 'Renamed on the other phone', description = 'theirs', updated_at = now() WHERE id = 1`,
    );

    const failure = await playlistMutations
      .updatePlaylist(
        null,
        {
          input: {
            playlistId: PLAYLIST_UUID,
            name: 'Renamed on this phone',
            basedOn: { updatedAt: before.updatedAt.toISOString(), name: 'Crimps', description: null },
          },
        },
        makeCtx(),
      )
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(GraphQLError);
    const extensions = (failure as GraphQLError).extensions;
    expect(extensions.code).toBe(PLAYLIST_UPDATE_CONFLICT_CODE);
    expect(extensions.playlistUuid).toBe(PLAYLIST_UUID);
    expect(extensions.serverName).toBe('Renamed on the other phone');
    expect(extensions.serverDescription).toBe('theirs');
    expect(extensions.serverIsPublic).toBe(false);
    expect(extensions.serverColor).toBeNull();
    expect(extensions.serverIcon).toBeNull();
    expect(typeof extensions.serverUpdatedAt).toBe('string');

    // Nothing was written.
    expect((await readPlaylist()).name).toBe('Renamed on the other phone');
  });

  it('applies when only a climb add bumped updatedAt (the false-conflict this design prevents)', async () => {
    const before = await readPlaylist();

    await playlistMutations.addClimbToPlaylist(
      null,
      { input: { playlistId: PLAYLIST_UUID, climbUuid: '11111111-1111-1111-1111-111111111111', angle: 40 } },
      makeCtx(),
    );

    const bumped = await readPlaylist();
    expect(bumped.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());

    await playlistMutations.updatePlaylist(
      null,
      {
        input: {
          playlistId: PLAYLIST_UUID,
          name: 'Renamed after the add',
          basedOn: { updatedAt: before.updatedAt.toISOString(), name: 'Crimps', description: null },
        },
      },
      makeCtx(),
    );

    expect((await readPlaylist()).name).toBe('Renamed after the add');
  });

  it('is a no-op success when a stale re-send asks for values that already landed', async () => {
    const before = await readPlaylist();
    await db.execute(sql`UPDATE playlists SET name = 'Same rename', updated_at = now() WHERE id = 1`);

    // The outbox replays the rename it already delivered — it can't know the
    // first attempt succeeded, and a bogus prompt here would be pure noise.
    await playlistMutations.updatePlaylist(
      null,
      {
        input: {
          playlistId: PLAYLIST_UUID,
          name: 'Same rename',
          basedOn: { updatedAt: before.updatedAt.toISOString(), name: 'Crimps', description: null },
        },
      },
      makeCtx(),
    );

    expect((await readPlaylist()).name).toBe('Same rename');
  });

  it('applies a "keep mine" retry rebased on the values from the conflict error', async () => {
    const before = await readPlaylist();
    await db.execute(sql`UPDATE playlists SET name = 'Theirs', updated_at = now() WHERE id = 1`);

    const failure = await playlistMutations
      .updatePlaylist(
        null,
        {
          input: {
            playlistId: PLAYLIST_UUID,
            name: 'Mine',
            basedOn: { updatedAt: before.updatedAt.toISOString(), name: 'Crimps', description: null },
          },
        },
        makeCtx(),
      )
      .then(
        () => null,
        (error: unknown) => error as GraphQLError,
      );

    const extensions = (failure as GraphQLError).extensions;

    await playlistMutations.updatePlaylist(
      null,
      {
        input: {
          playlistId: PLAYLIST_UUID,
          name: 'Mine',
          basedOn: {
            updatedAt: extensions.serverUpdatedAt as string,
            name: extensions.serverName as string,
            description: extensions.serverDescription as string | null,
            isPublic: extensions.serverIsPublic as boolean,
            color: extensions.serverColor as string | null,
            icon: extensions.serverIcon as string | null,
          },
        },
      },
      makeCtx(),
    );

    expect((await readPlaylist()).name).toBe('Mine');
  });

  it('still rejects a non-owner', async () => {
    await expect(
      playlistMutations.updatePlaylist(null, { input: { playlistId: PLAYLIST_UUID, name: 'Not mine' } }, {
        ...makeCtx(),
        userId: 'not-the-owner',
      } as ConnectionContext),
    ).rejects.toThrow('do not have permission');

    expect((await readPlaylist()).name).toBe('Crimps');
  });
});
