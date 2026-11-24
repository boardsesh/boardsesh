import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { auroraWallSources, userBoards } from '@boardsesh/db/schema';
import { boardUuidForSource, type PublicBoardLocationInput } from '@boardsesh/location-sync';
import type { AuroraLocationBoardName, AuroraPinWithUser } from './locations-sync';

type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;
export type AuroraWallSourceMapping = {
  sourceKey: string;
  sourceBoardUuid: string;
  boardType: AuroraLocationBoardName;
  gymUserId: number;
  wallUuid: string;
  serialNumber: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
};

/** Match exact fetched walls to published records, never infer from configuration alone. */
export function buildAuroraWallSourceMappings(
  board: AuroraLocationBoardName,
  pins: AuroraPinWithUser[],
  records: PublicBoardLocationInput[],
): AuroraWallSourceMapping[] {
  const recordsByKey = new Map(records.map((record) => [record.sourceKey, record]));
  const mappings = new Map<string, AuroraWallSourceMapping>();
  for (const { pin, user } of pins) {
    if (!user || user.id !== pin.id) continue;
    const walls = [...(user.walls ?? [])].sort(
      (first, second) =>
        (first.created_at ?? '').localeCompare(second.created_at ?? '') || first.uuid.localeCompare(second.uuid),
    );
    for (const [wallIndex, wall] of walls.entries()) {
      const sourceKey = wallIndex === 0 ? `${board}:${pin.id}` : `${board}:${pin.id}:${wall.uuid}`;
      const record = recordsByKey.get(sourceKey);
      const serialNumber = typeof wall.serial_number === 'string' ? wall.serial_number.trim() : null;
      if (
        !record ||
        !wall.uuid ||
        wall.is_listed !== true ||
        !serialNumber ||
        serialNumber.length > 128 ||
        !Number.isFinite(record.latitude) ||
        !Number.isFinite(record.longitude) ||
        record.boardType !== board ||
        record.serialNumber?.trim() !== serialNumber ||
        record.setIds
          .split(',')
          .map(Number)
          .sort((left, right) => left - right)
          .join(',') !==
          [...(wall.set_ids ?? [])]
            .map(Number)
            .sort((left, right) => left - right)
            .join(',') ||
        record.layoutId !== Number(wall.layout_id) ||
        record.sizeId !== Number(wall.product_size_id)
      ) {
        continue;
      }
      mappings.set(sourceKey, {
        sourceKey,
        sourceBoardUuid: boardUuidForSource(sourceKey),
        boardType: board,
        gymUserId: pin.id,
        wallUuid: wall.uuid,
        serialNumber,
        layoutId: record.layoutId,
        sizeId: record.sizeId,
        setIds: record.setIds,
      });
    }
  }
  return [...mappings.values()];
}

export type AuroraSerialWitness = Omit<AuroraWallSourceMapping, 'sourceBoardUuid'> & {
  sourceBoardUuid: null;
  isListed: false;
};

/**
 * Keep every valid observed physical serial independently of publishability.
 * Keys include wall and serial so unlisting, configuration changes and controller
 * replacement cannot erase a previously observed serial conflict.
 */
export function buildAuroraSerialWitnesses(
  board: AuroraLocationBoardName,
  pins: AuroraPinWithUser[],
): AuroraSerialWitness[] {
  const witnesses = new Map<string, AuroraSerialWitness>();
  const identifier = (input: unknown): input is string =>
    typeof input === 'string' && input.length > 0 && input.length <= 128 && input.trim() === input;
  const databaseId = (input: unknown): input is number =>
    typeof input === 'number' && Number.isInteger(input) && input > 0 && input <= 2_147_483_647;
  for (const { pin, user } of pins) {
    if (!user || user.id !== pin.id || !databaseId(pin.id)) continue;
    for (const wall of user.walls ?? []) {
      if (
        !identifier(wall.uuid) ||
        !identifier(wall.serial_number) ||
        !databaseId(wall.layout_id) ||
        !databaseId(wall.product_size_id) ||
        !Array.isArray(wall.set_ids) ||
        !wall.set_ids.every(databaseId)
      )
        continue;
      const sourceKey = `aurora-observation:${board}:${pin.id}:${wall.uuid}:${wall.serial_number}`;
      witnesses.set(sourceKey, {
        sourceKey,
        sourceBoardUuid: null,
        isListed: false,
        boardType: board,
        gymUserId: pin.id,
        wallUuid: wall.uuid,
        serialNumber: wall.serial_number,
        layoutId: wall.layout_id,
        sizeId: wall.product_size_id,
        setIds: [...new Set(wall.set_ids)].sort((left, right) => left - right).join(','),
      });
    }
  }
  return [...witnesses.values()];
}

/** Refresh only successfully fetched gyms; unavailable gyms retain their previous provenance. */
export async function syncAuroraWallSources(
  db: DrizzleDb,
  board: AuroraLocationBoardName,
  pins: AuroraPinWithUser[],
  records: PublicBoardLocationInput[],
  missingGymIds: number[] = [],
): Promise<void> {
  const fetchedGymIds = [
    ...new Set([
      ...pins.filter(({ pin, user }) => user?.id === pin.id && Array.isArray(user.walls)).map(({ pin }) => pin.id),
      ...missingGymIds,
    ]),
  ];
  if (!fetchedGymIds.length) return;
  const candidates = buildAuroraWallSourceMappings(board, pins, records);
  const candidateUuids = candidates.map((mapping) => mapping.sourceBoardUuid);
  await db.transaction(async (transaction) => {
    const existingBoards = candidateUuids.length
      ? await transaction
          .select({ uuid: userBoards.uuid })
          .from(userBoards)
          .where(inArray(userBoards.uuid, candidateUuids))
      : [];
    const existingUuids = new Set(existingBoards.map((boardRow) => boardRow.uuid));
    const mappings = candidates.filter((mapping) => existingUuids.has(mapping.sourceBoardUuid));
    const listedKeys = mappings.map((mapping) => mapping.sourceKey);
    const observations = [
      ...mappings.map((mapping) => ({ ...mapping, isListed: true })),
      ...buildAuroraSerialWitnesses(board, pins),
    ];
    // A failed or partial gym fetch is deliberately excluded from this set.
    await transaction
      .update(auroraWallSources)
      .set({ isListed: false, updatedAt: new Date() })
      .where(
        and(
          eq(auroraWallSources.boardType, board),
          inArray(auroraWallSources.gymUserId, fetchedGymIds),
          eq(auroraWallSources.isListed, true),
          listedKeys.length ? notInArray(auroraWallSources.sourceKey, listedKeys) : undefined,
        ),
      );
    for (let start = 0; start < observations.length; start += 500) {
      await transaction
        .insert(auroraWallSources)
        .values(observations.slice(start, start + 500))
        .onConflictDoUpdate({
          target: auroraWallSources.sourceKey,
          set: {
            sourceBoardUuid: sql`excluded.source_board_uuid`,
            boardType: sql`excluded.board_type`,
            gymUserId: sql`excluded.gym_user_id`,
            wallUuid: sql`excluded.wall_uuid`,
            serialNumber: sql`excluded.serial_number`,
            layoutId: sql`excluded.layout_id`,
            sizeId: sql`excluded.size_id`,
            setIds: sql`excluded.set_ids`,
            isListed: sql`excluded.is_listed`,
            updatedAt: new Date(),
          },
        });
    }
  });
}
