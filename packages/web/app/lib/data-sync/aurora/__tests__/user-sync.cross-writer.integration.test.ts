// @vitest-environment node
// Real-PostgreSQL daemon↔legacy-web arbitration coverage for issue #3950.
// It self-skips in the infra-less default test job and is required explicitly
// by CI's named Aurora circuit database gate.

import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { boardCircuits, boardUsers, playlistClimbs, playlistOwnership, playlists, users } from '@boardsesh/db/schema';
import { upsertTableData as daemonUpsertTableData } from '@boardsesh/aurora-sync/sync';

vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/db/db', () => ({ getDb: () => ({}) }));

import { upsertTableData as webUpsertTableData } from '../user-sync';

function localDatabaseUrl(): string | null {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return null;
  try {
    const hostname = new URL(databaseUrl).hostname.toLowerCase();
    return ['localhost', '127.0.0.1', 'postgres'].includes(hostname) ? databaseUrl : null;
  } catch {
    return null;
  }
}

const integrationRequired = process.env.REQUIRE_AURORA_CIRCUIT_INTEGRATION === '1';
const describeIntegration = localDatabaseUrl() || integrationRequired ? describe : describe.skip;

/** Release both claimants only after both outer transactions are open. */
function createBarrier(participantCount: number): () => Promise<void> {
  let arrived = 0;
  let release: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived === participantCount) release?.();
    await ready;
  };
}

describeIntegration('Aurora daemon ↔ web circuit ownership arbitration (#3950)', () => {
  it('gives one concurrent cross-surface claimant sole ownership and preserves its climbs', async (testContext) => {
    const databaseUrl = localDatabaseUrl();
    if (!databaseUrl) {
      if (integrationRequired) {
        throw new Error('REQUIRE_AURORA_CIRCUIT_INTEGRATION=1 requires DATABASE_URL to point at local PostgreSQL');
      }
      testContext.skip('set DATABASE_URL to a local, migrated PostgreSQL database to run issue #3950 coverage');
      return;
    }

    const client = postgres(databaseUrl, { max: 4, prepare: false, idle_timeout: 5, onnotice: () => {} });
    const db = drizzle(client);
    const [{ ready }] = await client<{ ready: boolean }[]>`
      SELECT
        to_regclass('public.board_circuits') IS NOT NULL
        AND to_regclass('public.playlists_aurora_id_idx') IS NOT NULL
        AND to_regclass('public.unique_playlist_ownership') IS NOT NULL AS ready
    `;
    if (!ready) {
      await client.end();
      const reason = 'local PostgreSQL schema is not current for daemon/web circuit arbitration';
      if (integrationRequired) throw new Error(reason);
      testContext.skip(reason);
      return;
    }

    const testTag = randomUUID();
    const circuitUuid = `issue-3950-cross-writer-${testTag}`;
    const userIds = [`issue-3950-daemon-${testTag}`, `issue-3950-web-${testTag}`] as const;
    const climbUuids = [`issue-3950-daemon-climb-${testTag}`, `issue-3950-web-climb-${testTag}`] as const;
    let auroraUserId: number | undefined;

    try {
      await db.insert(users).values([
        { id: userIds[0], email: `${userIds[0]}@example.invalid` },
        { id: userIds[1], email: `${userIds[1]}@example.invalid` },
      ]);

      const candidateBase = 1_700_000_000 + (Number.parseInt(testTag.slice(0, 7), 16) % 100_000_000);
      for (let attempt = 0; attempt < 20 && auroraUserId === undefined; attempt += 1) {
        const inserted = await db
          .insert(boardUsers)
          .values({
            boardType: 'tension',
            id: candidateBase + attempt,
            username: `issue-3950-cross-writer-${testTag}`,
          })
          .onConflictDoNothing()
          .returning({ id: boardUsers.id });
        auroraUserId = inserted[0]?.id;
      }
      if (auroraUserId === undefined) throw new Error('Could not allocate a board user fixture');
      const claimedAuroraUserId = auroraUserId;

      const awaitBothTransactions = createBarrier(2);
      const daemonLogs: string[] = [];
      const webWarnings: string[] = [];
      const daemonRow = {
        uuid: circuitUuid,
        name: 'Daemon claim',
        description: '',
        color: '',
        is_public: '',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        climbs: [{ climb_uuid: climbUuids[0] }],
      };
      const webRow = {
        ...daemonRow,
        name: 'Web claim',
        climbs: [{ climb_uuid: climbUuids[1] }],
      };

      const daemonClaim = db.transaction(async (transaction) => {
        await awaitBothTransactions();
        return daemonUpsertTableData(
          transaction as never,
          'tension',
          'circuits',
          claimedAuroraUserId,
          userIds[0],
          [daemonRow] as never,
          (message) => daemonLogs.push(message),
        );
      });
      const webClaim = db.transaction(async (transaction) => {
        await awaitBothTransactions();
        await webUpsertTableData(
          transaction as never,
          'tension',
          'circuits',
          claimedAuroraUserId,
          userIds[1],
          [webRow] as never,
          { warn: (message) => webWarnings.push(message), error: (message) => webWarnings.push(message) },
        );
      });

      const [daemonOutcome] = await Promise.all([daemonClaim, webClaim]);
      const ownerRows = await db
        .select({ userId: playlistOwnership.userId })
        .from(playlists)
        .innerJoin(playlistOwnership, eq(playlistOwnership.playlistId, playlists.id))
        .where(and(eq(playlists.auroraId, circuitUuid), eq(playlistOwnership.role, 'owner')));
      expect(ownerRows).toHaveLength(1);
      expect(userIds).toContain(ownerRows[0]?.userId);

      const winnerIndex = ownerRows[0]?.userId === userIds[0] ? 0 : 1;
      const climbRows = await db
        .select({ climbUuid: playlistClimbs.climbUuid })
        .from(playlists)
        .innerJoin(playlistClimbs, eq(playlistClimbs.playlistId, playlists.id))
        .where(eq(playlists.auroraId, circuitUuid));
      expect(climbRows).toEqual([{ climbUuid: climbUuids[winnerIndex] }]);

      if (winnerIndex === 0) {
        expect(webWarnings.some((message) => message.includes('"reason":"foreign"'))).toBe(true);
      } else {
        expect(daemonOutcome.skipped).toBe(1);
        expect(daemonLogs.some((message) => message.includes('"reason":"foreign"'))).toBe(true);
      }
    } finally {
      await db.delete(playlists).where(eq(playlists.auroraId, circuitUuid));
      await db
        .delete(boardCircuits)
        .where(and(eq(boardCircuits.boardType, 'tension'), eq(boardCircuits.uuid, circuitUuid)));
      if (auroraUserId !== undefined) {
        await db.delete(boardUsers).where(and(eq(boardUsers.boardType, 'tension'), eq(boardUsers.id, auroraUserId)));
      }
      await db.delete(users).where(inArray(users.id, [...userIds]));
      await client.end();
    }
  }, 20_000);
});
