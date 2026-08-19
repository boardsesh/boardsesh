import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq, inArray } from 'drizzle-orm';
import { createScriptDb, isLocalDatabaseUrl } from './db-connection.js';
import { playlistClimbs, playlistOwnership, playlists, userPlaylistPins } from '../src/schema/app/playlists.js';
import { playlistFollows } from '../src/schema/app/follows.js';
import { syncDeletions } from '../src/schema/app/sync-deletions.js';
import { users } from '../src/schema/auth/users.js';
import { applyRepairPlans, loadAdopterAttachments, loadCrossLinkedPlaylists } from './repair-cross-linked-playlists.js';
import { planCrossLinkedPlaylistRepairs, selectApplyablePlans } from './repair-cross-linked-playlists-helpers.js';

/**
 * Only ever runs against a local database. `.env.local` carries a real
 * (read-only) production credential and db-connection.ts loads it into
 * process.env on import, so the local check is not optional — isLocalDatabaseUrl
 * fails closed on anything it can't positively identify as local/dev.
 */
function repairTestDatabaseUrl(): string | null {
  const candidateUrl =
    process.env.REPAIR_CROSS_LINKED_PLAYLISTS_DB_URL ?? process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? null;
  if (!candidateUrl) {
    return null;
  }
  return isLocalDatabaseUrl(candidateUrl) ? candidateUrl : null;
}

const CREATOR_OWNED_AT = new Date('2026-03-29T08:00:00Z');
const ADOPTER_OWNED_AT = new Date('2026-03-29T14:00:00Z');

void describe('repair-cross-linked-playlists apply path', () => {
  void it('revokes only the adopter ownership row and its pin/follow, leaving everything else intact', async (testContext) => {
    const databaseUrl = repairTestDatabaseUrl();
    if (!databaseUrl) {
      testContext.skip(
        'set REPAIR_CROSS_LINKED_PLAYLISTS_DB_URL (or DATABASE_URL) to a local migrated database to run this integration test',
      );
      return;
    }

    const { db, close } = createScriptDb(databaseUrl);
    const rollbackMarker = new Error('rollback repair fixture');

    try {
      await db.transaction(async (transaction) => {
        const tag = `repair-xlink-${Date.now()}`;
        const creatorUserId = `${tag}-creator`;
        const adopterUserId = `${tag}-adopter`;
        const lowercaseUserId = `${tag}-lower`;
        const uppercaseUserId = `${tag}-upper`;
        const strangerUserId = `${tag}-stranger`;

        await transaction.insert(users).values([
          { id: creatorUserId, email: `${tag}-creator@example.test`, name: 'Creator' },
          { id: adopterUserId, email: `${tag}-adopter@example.test`, name: 'Adopter' },
          { id: lowercaseUserId, email: `${tag}-dupe@example.test`, name: 'Dupe lower' },
          { id: uppercaseUserId, email: `${tag}-DUPE@example.test`, name: 'Dupe upper' },
          { id: strangerUserId, email: `${tag}-stranger@example.test`, name: 'Stranger' },
        ]);

        async function insertPlaylist(suffix: string, auroraId: string): Promise<bigint> {
          const [inserted] = await transaction
            .insert(playlists)
            .values({
              uuid: `${tag}-${suffix}`,
              boardType: 'kilter',
              name: `Fixture ${suffix}`,
              auroraType: 'circuits',
              auroraId,
              isPublic: false,
            })
            .returning({ id: playlists.id });
          assert.ok(inserted, `expected an inserted playlist for ${suffix}`);
          return inserted.id;
        }

        // 1. json-import residue: repairable.
        const jsonImportPlaylistId = await insertPlaylist('json-import', `json-import-circuit-${tag}`);
        // 2. two accounts of the same person: deferred to merge-accounts.ts (#3278).
        const mergeCandidatePlaylistId = await insertPlaylist('merge-candidate', `circuit-${tag}-merge`);
        // 3. two genuinely different people on a real Aurora circuit: refused.
        const unknownCausePlaylistId = await insertPlaylist('unknown-cause', `circuit-${tag}-unknown`);
        // 4. a healthy single-owner playlist: must never be picked up at all.
        const singleOwnerPlaylistId = await insertPlaylist('single-owner', `circuit-${tag}-single`);

        await transaction.insert(playlistOwnership).values([
          { playlistId: jsonImportPlaylistId, userId: creatorUserId, role: 'owner', createdAt: CREATOR_OWNED_AT },
          { playlistId: jsonImportPlaylistId, userId: adopterUserId, role: 'owner', createdAt: ADOPTER_OWNED_AT },
          { playlistId: mergeCandidatePlaylistId, userId: lowercaseUserId, role: 'owner', createdAt: CREATOR_OWNED_AT },
          { playlistId: mergeCandidatePlaylistId, userId: uppercaseUserId, role: 'owner', createdAt: ADOPTER_OWNED_AT },
          { playlistId: unknownCausePlaylistId, userId: creatorUserId, role: 'owner', createdAt: CREATOR_OWNED_AT },
          { playlistId: unknownCausePlaylistId, userId: strangerUserId, role: 'owner', createdAt: ADOPTER_OWNED_AT },
          { playlistId: singleOwnerPlaylistId, userId: creatorUserId, role: 'owner', createdAt: CREATOR_OWNED_AT },
        ]);

        await transaction.insert(playlistClimbs).values([
          { playlistId: jsonImportPlaylistId, climbUuid: `${tag}-climb-a`, angle: 40, position: 0 },
          { playlistId: jsonImportPlaylistId, climbUuid: `${tag}-climb-b`, angle: 40, position: 1 },
        ]);

        await transaction.insert(userPlaylistPins).values([
          { playlistId: jsonImportPlaylistId, userId: adopterUserId },
          { playlistId: jsonImportPlaylistId, userId: creatorUserId },
          { playlistId: mergeCandidatePlaylistId, userId: uppercaseUserId },
        ]);

        await transaction.insert(playlistFollows).values([
          { playlistUuid: `${tag}-json-import`, followerId: adopterUserId },
          { playlistUuid: `${tag}-json-import`, followerId: strangerUserId },
        ]);

        const fixturePlaylistIds = [
          jsonImportPlaylistId,
          mergeCandidatePlaylistId,
          unknownCausePlaylistId,
          singleOwnerPlaylistId,
        ];
        const fixtureIdFilter = fixturePlaylistIds.map(String);

        async function countOwnershipRows(): Promise<number> {
          const rows = await transaction
            .select({ id: playlistOwnership.id })
            .from(playlistOwnership)
            .where(inArray(playlistOwnership.playlistId, fixturePlaylistIds));
          return rows.length;
        }

        // --- dry-run: plan everything, write nothing -------------------------
        const crossLinked = await loadCrossLinkedPlaylists(transaction, fixtureIdFilter);
        assert.deepEqual(
          crossLinked.map((playlist) => playlist.playlistId).sort(),
          [jsonImportPlaylistId, mergeCandidatePlaylistId, unknownCausePlaylistId].map(String).sort(),
          'the single-owner playlist must not be reported as cross-linked',
        );

        const jsonImportReport = crossLinked.find((playlist) => playlist.playlistId === String(jsonImportPlaylistId));
        assert.equal(jsonImportReport?.climbCount, 2);
        assert.equal(jsonImportReport?.owners.length, 2);

        const plans = planCrossLinkedPlaylistRepairs(crossLinked);
        const actionByPlaylistId = new Map(plans.map((plan) => [plan.playlist.playlistId, plan.action]));
        assert.equal(actionByPlaylistId.get(String(jsonImportPlaylistId)), 'revoke-adopter');
        assert.equal(actionByPlaylistId.get(String(mergeCandidatePlaylistId)), 'defer-to-account-merge');
        assert.equal(actionByPlaylistId.get(String(unknownCausePlaylistId)), 'refuse');

        const attachments = await loadAdopterAttachments(transaction, plans);
        assert.equal(attachments.pinnedPlaylistIds.has(String(jsonImportPlaylistId)), true);
        assert.equal(attachments.followedPlaylistUuids.has(`${tag}-json-import`), true);

        assert.equal(await countOwnershipRows(), 7, 'planning and reporting must not write');

        // --- scoping ---------------------------------------------------------
        const scopedToOnePlaylist = await loadCrossLinkedPlaylists(transaction, [String(mergeCandidatePlaylistId)]);
        assert.deepEqual(
          scopedToOnePlaylist.map((playlist) => playlist.playlistId),
          [String(mergeCandidatePlaylistId)],
        );

        // --- apply -----------------------------------------------------------
        const applyablePlans = selectApplyablePlans(plans, { includeMergeCandidates: false });
        assert.deepEqual(
          applyablePlans.map((plan) => plan.playlist.playlistId),
          [String(jsonImportPlaylistId)],
        );

        const counts = await applyRepairPlans(transaction, applyablePlans);
        assert.deepEqual(counts, {
          ownershipRowsDeleted: 1,
          pinsDeleted: 1,
          followsDeleted: 1,
          tombstonesWritten: 1,
          skippedByDrift: [],
        });

        const survivingOwners = await transaction
          .select({ playlistId: playlistOwnership.playlistId, userId: playlistOwnership.userId })
          .from(playlistOwnership)
          .where(inArray(playlistOwnership.playlistId, fixturePlaylistIds));
        assert.deepEqual(
          survivingOwners.map((owner) => `${owner.playlistId}:${owner.userId}`).sort(),
          [
            `${jsonImportPlaylistId}:${creatorUserId}`,
            `${mergeCandidatePlaylistId}:${lowercaseUserId}`,
            `${mergeCandidatePlaylistId}:${uppercaseUserId}`,
            `${singleOwnerPlaylistId}:${creatorUserId}`,
            `${unknownCausePlaylistId}:${creatorUserId}`,
            `${unknownCausePlaylistId}:${strangerUserId}`,
          ].sort(),
        );

        const survivingPlaylists = await transaction
          .select({ id: playlists.id })
          .from(playlists)
          .where(inArray(playlists.id, fixturePlaylistIds));
        assert.equal(survivingPlaylists.length, 4, 'no playlist may be deleted');

        const survivingClimbs = await transaction
          .select({ id: playlistClimbs.id })
          .from(playlistClimbs)
          .where(eq(playlistClimbs.playlistId, jsonImportPlaylistId));
        assert.equal(survivingClimbs.length, 2, 'playlist_climbs must be untouched');

        const survivingPins = await transaction
          .select({ playlistId: userPlaylistPins.playlistId, userId: userPlaylistPins.userId })
          .from(userPlaylistPins)
          .where(inArray(userPlaylistPins.playlistId, fixturePlaylistIds));
        assert.deepEqual(
          survivingPins.map((pin) => `${pin.playlistId}:${pin.userId}`).sort(),
          [`${jsonImportPlaylistId}:${creatorUserId}`, `${mergeCandidatePlaylistId}:${uppercaseUserId}`].sort(),
          "only the adopter's pin is removed",
        );

        const survivingFollows = await transaction
          .select({ followerId: playlistFollows.followerId })
          .from(playlistFollows)
          .where(eq(playlistFollows.playlistUuid, `${tag}-json-import`));
        assert.deepEqual(
          survivingFollows.map((follow) => follow.followerId),
          [strangerUserId],
          "an unrelated user's follow is left alone",
        );

        // The offline pull joins playlist_ownership, which has no delete
        // trigger — without this tombstone the adopter's device would keep the
        // playlist (and its climbs) forever. Scoped to the adopter, so the
        // creator's devices never see it.
        const playlistTombstones = await transaction
          .select({ recordId: syncDeletions.recordId, userId: syncDeletions.userId })
          .from(syncDeletions)
          .where(and(eq(syncDeletions.tableName, 'playlists'), eq(syncDeletions.recordId, `${tag}-json-import`)));
        assert.deepEqual(
          playlistTombstones,
          [{ recordId: `${tag}-json-import`, userId: adopterUserId }],
          'exactly one adopter-scoped playlists tombstone is written',
        );

        const creatorScopedTombstones = await transaction
          .select({ id: syncDeletions.id })
          .from(syncDeletions)
          .where(and(eq(syncDeletions.tableName, 'playlists'), eq(syncDeletions.userId, creatorUserId)));
        assert.equal(creatorScopedTombstones.length, 0, "the creator's clients must not be told to drop the playlist");

        // --- idempotence: the playlist is no longer cross-linked -------------
        const afterRepair = await loadCrossLinkedPlaylists(transaction, [String(jsonImportPlaylistId)]);
        assert.deepEqual(afterRepair, []);

        // --- drift guard: a stale plan is skipped, not applied ---------------
        const stalePlans = selectApplyablePlans(planCrossLinkedPlaylistRepairs(crossLinked), {
          includeMergeCandidates: false,
        });
        const staleCounts = await applyRepairPlans(transaction, stalePlans);
        assert.deepEqual(staleCounts, {
          ownershipRowsDeleted: 0,
          pinsDeleted: 0,
          followsDeleted: 0,
          tombstonesWritten: 0,
          skippedByDrift: [String(jsonImportPlaylistId)],
        });

        // --- opting in surfaces the merge candidate, still not the refusal ---
        const withMergeCandidates = selectApplyablePlans(plans, { includeMergeCandidates: true });
        assert.deepEqual(
          withMergeCandidates.map((plan) => plan.playlist.playlistId).sort(),
          [String(jsonImportPlaylistId), String(mergeCandidatePlaylistId)].sort(),
        );

        // The opt-in widens the write set, so exercise it end-to-end rather than
        // trusting that a defer-to-account-merge plan walks the same revoke path.
        // The json-import plan rides along and is drift-skipped: it was already
        // repaired above.
        const mergeCandidateCounts = await applyRepairPlans(transaction, withMergeCandidates);
        assert.deepEqual(mergeCandidateCounts, {
          ownershipRowsDeleted: 1,
          pinsDeleted: 1,
          followsDeleted: 0,
          tombstonesWritten: 1,
          skippedByDrift: [String(jsonImportPlaylistId)],
        });

        const mergeCandidateOwners = await transaction
          .select({ userId: playlistOwnership.userId })
          .from(playlistOwnership)
          .where(eq(playlistOwnership.playlistId, mergeCandidatePlaylistId));
        assert.deepEqual(
          mergeCandidateOwners.map((owner) => owner.userId),
          [lowercaseUserId],
          'the earlier of the two duplicate accounts keeps the playlist',
        );

        const survivingUsers = await transaction
          .select({ id: users.id })
          .from(users)
          .where(inArray(users.id, [creatorUserId, adopterUserId, lowercaseUserId, uppercaseUserId, strangerUserId]));
        assert.equal(survivingUsers.length, 5, 'no user row may be deleted');

        throw rollbackMarker;
      });
    } catch (error: unknown) {
      if (error !== rollbackMarker) {
        throw error;
      }
    } finally {
      await close();
    }
  });
});
