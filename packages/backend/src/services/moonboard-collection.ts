import { and, asc, eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { GraphQLError } from 'graphql';
import * as schema from '@boardsesh/db/schema';
import { refreshPlaylistGradeSummariesFor } from '@boardsesh/db/queries';
import type {
  MoonBoardCollectionImportInput,
  MoonBoardCollectionDestination,
  MoonBoardCollectionImportResult,
  MoonBoardCollectionMatch,
  MoonBoardCollectionPreview,
  MoonBoardCollectionPreviewInput,
} from '@boardsesh/shared-schema';
import {
  findPublicMoonBoardCollectionCandidates,
  moonBoardGradeToDifficultyId,
  pickClimbByName,
} from './moonboard-import';
import { logger } from '../utils/logger';

type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** Read effective item privacy rather than the legacy public switch alone. */
export async function listMoonBoardCollectionDestinations(
  database: DrizzleDb,
  userId: string,
  layoutId: number,
): Promise<MoonBoardCollectionDestination[]> {
  const playlists = await database
    .select({
      id: schema.playlists.id,
      uuid: schema.playlists.uuid,
      name: schema.playlists.name,
      layoutId: schema.playlists.layoutId,
    })
    .from(schema.playlists)
    .innerJoin(
      schema.playlistOwnership,
      and(
        eq(schema.playlistOwnership.playlistId, schema.playlists.id),
        eq(schema.playlistOwnership.userId, userId),
        eq(schema.playlistOwnership.role, 'owner'),
      ),
    )
    .leftJoin(
      schema.contentPrivacy,
      and(eq(schema.contentPrivacy.entityType, 'playlist'), eq(schema.contentPrivacy.entityId, schema.playlists.uuid)),
    )
    .where(
      and(
        eq(schema.playlists.boardType, 'moonboard'),
        eq(schema.playlists.isPublic, false),
        or(isNull(schema.playlists.layoutId), eq(schema.playlists.layoutId, layoutId)),
        or(isNull(schema.contentPrivacy.entityId), eq(schema.contentPrivacy.audience, 'only_me')),
      ),
    )
    .orderBy(asc(schema.playlists.name), asc(schema.playlists.id))
    .limit(500);
  return playlists.map((playlist) => ({ ...playlist, id: playlist.id.toString() }));
}

/** Read-only catalogue resolution. The returned rows deliberately contain no candidate details for misses. */
export async function previewMoonBoardCollection(
  database: DrizzleDb,
  input: MoonBoardCollectionPreviewInput,
): Promise<MoonBoardCollectionPreview> {
  const candidatesByLine = await findPublicMoonBoardCollectionCandidates(
    database,
    input.rows,
    input.layoutId,
    input.angle,
  );
  const seenClimbs = new Set<string>();
  const rows: MoonBoardCollectionMatch[] = input.rows.map((row) => {
    const candidates = candidatesByLine.get(row.lineNumber) ?? [];
    const difficultyId = moonBoardGradeToDifficultyId(row.grade);
    const match = difficultyId == null ? null : pickClimbByName(candidates, { setter: row.setter, difficultyId });
    if (!match) {
      return {
        lineNumber: row.lineNumber,
        name: row.name,
        grade: row.grade,
        climbUuid: null,
        status: new Set(candidates.map((candidate) => candidate.climbUuid)).size > 1 ? 'ambiguous' : 'missing',
      };
    }
    const duplicate = seenClimbs.has(match.climbUuid);
    seenClimbs.add(match.climbUuid);
    return {
      lineNumber: row.lineNumber,
      name: row.name,
      grade: row.grade,
      climbUuid: match.climbUuid,
      status: duplicate ? 'duplicate' : 'matched',
    };
  });
  return {
    rows,
    matched: rows.filter((row) => row.status === 'matched').length,
    missing: rows.filter((row) => row.status === 'missing').length,
    ambiguous: rows.filter((row) => row.status === 'ambiguous').length,
    duplicates: rows.filter((row) => row.status === 'duplicate').length,
  };
}

function invalidDestination(): GraphQLError {
  return new GraphQLError('Choose an owned private MoonBoard playlist for this layout', {
    extensions: { code: 'MOONBOARD_COLLECTION_DESTINATION_INVALID' },
  });
}

function isDeadlock(error: unknown): boolean {
  let currentError = error;
  for (let depth = 0; depth < 5 && typeof currentError === 'object' && currentError !== null; depth += 1) {
    if ('code' in currentError && currentError.code === '40P01') return true;
    currentError = 'cause' in currentError ? currentError.cause : undefined;
  }
  return false;
}

async function retryDeadlockedTransaction<Result>(operation: () => Promise<Result>): Promise<Result> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      // Concurrent multi-row inserts can race other playlist writers. Retry
      // the entire rolled-back transaction, never a subset of its writes.
      if (attempt >= 2 || !isDeadlock(error)) throw error;
    }
  }
}

/**
 * Save references only: this path never changes climbs, author identity, ticks,
 * grades or votes. The source is re-resolved inside the write transaction.
 */
export async function importMoonBoardCollection(
  database: DrizzleDb,
  userId: string,
  input: MoonBoardCollectionImportInput,
): Promise<MoonBoardCollectionImportResult> {
  const result = await retryDeadlockedTransaction(() =>
    database.transaction(
      async (transaction) => {
        const now = new Date();
        if (!input.playlistId) {
          const [created] = await transaction
            .insert(schema.playlists)
            .values({
              uuid: input.playlistUuid,
              boardType: 'moonboard',
              layoutId: input.layoutId,
              name: input.playlistName,
              isPublic: false,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoNothing({ target: schema.playlists.uuid })
            .returning({ id: schema.playlists.id });
          if (created) {
            await transaction
              .insert(schema.playlistOwnership)
              .values({ playlistId: created.id, userId, role: 'owner' });
            // This transaction just created the owned destination. Record its
            // private audience explicitly so privacy reads never infer a wider
            // account default, including when a deleted UUID is reused.
            const privacy = {
              ownerId: userId,
              audience: 'only_me' as const,
              publicConsentRevision: null,
              updatedAt: now,
            };
            await transaction
              .insert(schema.contentPrivacy)
              .values({ entityType: 'playlist', entityId: input.playlistUuid, ...privacy })
              .onConflictDoUpdate({
                target: [schema.contentPrivacy.entityType, schema.contentPrivacy.entityId],
                set: privacy,
              });
          }
        }

        // UUID conflicts are never interpreted as proof that this caller owns
        // a row. Recheck and lock the destination again before committing.
        const [playlist] = await transaction
          .select()
          .from(schema.playlists)
          .where(eq(schema.playlists.uuid, input.playlistUuid));
        if (
          !playlist ||
          (input.playlistId != null && playlist.id.toString() !== input.playlistId) ||
          playlist.isPublic ||
          playlist.boardType !== 'moonboard' ||
          (playlist.layoutId != null && playlist.layoutId !== input.layoutId)
        ) {
          throw invalidDestination();
        }
        const [ownership] = await transaction
          .select({ id: schema.playlistOwnership.id })
          .from(schema.playlistOwnership)
          .where(
            and(
              eq(schema.playlistOwnership.playlistId, playlist.id),
              eq(schema.playlistOwnership.userId, userId),
              eq(schema.playlistOwnership.role, 'owner'),
            ),
          );
        if (!ownership) throw invalidDestination();

        const preview = await previewMoonBoardCollection(transaction, input);
        if (preview.matched === 0) {
          throw new GraphQLError('No catalogue climbs matched this collection', {
            extensions: { code: 'MOONBOARD_COLLECTION_NO_MATCHES' },
          });
        }

        const existingRows = await transaction
          .select({ climbUuid: schema.playlistClimbs.climbUuid, position: schema.playlistClimbs.position })
          .from(schema.playlistClimbs)
          .where(eq(schema.playlistClimbs.playlistId, playlist.id));
        const existingClimbs = new Set(existingRows.map((row) => row.climbUuid));
        let nextPosition = existingRows.reduce((maximum, row) => Math.max(maximum, row.position), -1) + 1;
        const inserts = preview.rows.flatMap((row) => {
          if (row.status !== 'matched' || !row.climbUuid || existingClimbs.has(row.climbUuid)) return [];
          return [
            {
              playlistId: playlist.id,
              climbUuid: row.climbUuid,
              angle: input.angle,
              position: nextPosition++,
              addedAt: now,
              updatedAt: now,
            },
          ];
        });
        const inserted =
          inserts.length === 0
            ? []
            : await transaction
                .insert(schema.playlistClimbs)
                // A shared lock order avoids two imports inserting the same
                // UUIDs in opposite source orders. Positions retain source order.
                .values([...inserts].sort((first, second) => first.climbUuid.localeCompare(second.climbUuid)))
                .onConflictDoNothing({ target: [schema.playlistClimbs.playlistId, schema.playlistClimbs.climbUuid] })
                .returning({ id: schema.playlistClimbs.id, climbUuid: schema.playlistClimbs.climbUuid });
        // Single-climb adds take the membership before the playlist. Follow
        // that order too, then hold the destination's audience stable through
        // commit. NO KEY UPDATE remains compatible with membership FK locks.
        const [lockedPlaylist] = await transaction
          .select()
          .from(schema.playlists)
          .where(eq(schema.playlists.id, playlist.id))
          .for('no key update');
        const [lockedPrivacy] = await transaction
          .select({ audience: schema.contentPrivacy.audience })
          .from(schema.contentPrivacy)
          .where(
            and(eq(schema.contentPrivacy.entityType, 'playlist'), eq(schema.contentPrivacy.entityId, playlist.uuid)),
          )
          .for('share');
        const [lockedOwnership] = await transaction
          .select({ id: schema.playlistOwnership.id })
          .from(schema.playlistOwnership)
          .where(
            and(
              eq(schema.playlistOwnership.playlistId, playlist.id),
              eq(schema.playlistOwnership.userId, userId),
              eq(schema.playlistOwnership.role, 'owner'),
            ),
          )
          .for('share');
        if (
          !lockedPlaylist ||
          !lockedOwnership ||
          lockedPlaylist.isPublic ||
          (lockedPrivacy != null && lockedPrivacy.audience !== 'only_me') ||
          lockedPlaylist.boardType !== 'moonboard' ||
          (lockedPlaylist.layoutId != null && lockedPlaylist.layoutId !== input.layoutId)
        ) {
          throw invalidDestination();
        }
        if (inserted.length > 0) {
          const committedAt = new Date();
          // Concurrent imports may have read the same initial max position.
          // Finalize this batch only after taking the playlist lock, placing
          // its new rows after every previously committed row in source order.
          const insertedIds = inserted.map((row) => row.id);
          const [lastPosition] = await transaction
            .select({ position: sql<number>`coalesce(max(${schema.playlistClimbs.position}), -1)` })
            .from(schema.playlistClimbs)
            .where(
              and(eq(schema.playlistClimbs.playlistId, playlist.id), notInArray(schema.playlistClimbs.id, insertedIds)),
            );
          const idsByClimb = new Map(inserted.map((row) => [row.climbUuid, row.id]));
          const orderedIds = inserts.flatMap((row) => {
            const insertedId = idsByClimb.get(row.climbUuid);
            return insertedId == null ? [] : [insertedId];
          });
          const positions = orderedIds.map(
            (rowId, index) => sql`when ${rowId} then ${(lastPosition?.position ?? -1) + index + 1}::integer`,
          );
          await transaction
            .update(schema.playlistClimbs)
            .set({
              position: sql<number>`case ${schema.playlistClimbs.id} ${sql.join(positions, sql` `)} end`,
              updatedAt: committedAt,
            })
            .where(inArray(schema.playlistClimbs.id, insertedIds));
          await transaction
            .update(schema.playlists)
            .set({ updatedAt: committedAt, lastAccessedAt: committedAt })
            .where(eq(schema.playlists.id, playlist.id));
        }
        return {
          playlistId: playlist.id.toString(),
          playlistUuid: playlist.uuid,
          imported: inserted.length,
          skipped: preview.matched + preview.duplicates - inserted.length,
          preview,
        };
      },
      { isolationLevel: 'read committed' },
    ),
  );

  if (result.imported > 0) {
    try {
      await refreshPlaylistGradeSummariesFor(database, [BigInt(result.playlistId)]);
    } catch (error) {
      logger.error('[MoonBoardCollection] Could not refresh playlist grade summary', {
        playlistId: result.playlistId,
        error,
      });
    }
  }
  return result;
}
