import { sql } from 'drizzle-orm';
import type {
  MoonBoardClimbDuplicateCandidateInput,
  MoonBoardClimbDuplicateMatch,
  MoonBoardHoldsInput,
} from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { executeRows } from '@boardsesh/db/client';
import { db } from '../../../db/client';
import { convertLitUpHoldsStringToMap } from '../../../db/queries/util/hold-state';

type MoonBoardHoldState = 'STARTING' | 'HAND' | 'FINISH';

type NormalizedMoonBoardHold = {
  holdId: number;
  holdState: MoonBoardHoldState;
};

type DuplicateCandidate = Pick<MoonBoardClimbDuplicateCandidateInput, 'clientKey' | 'holds'>;

type DuplicateLookupRow = {
  uuid: string;
  name: string | null;
  ascensionist_count: number;
  signature: string;
};

type LegacyDuplicateLookupRow = {
  uuid: string;
  name: string | null;
  frames: string | null;
  ascensionist_count: number;
};

const MOONBOARD_ROLE_CODE_BY_STATE: Record<MoonBoardHoldState, number> = {
  STARTING: 42,
  HAND: 43,
  FINISH: 44,
};

const MOONBOARD_COORDINATE_GROUPS: Array<{
  key: keyof MoonBoardHoldsInput;
  state: MoonBoardHoldState;
}> = [
  { key: 'start', state: 'STARTING' },
  { key: 'hand', state: 'HAND' },
  { key: 'finish', state: 'FINISH' },
];

export const MOONBOARD_DUPLICATE_ERROR_PREFIX = 'A MoonBoard climb with the same holds already exists';

function coordinateToHoldId(coord: string): number {
  const colIndex = coord[0].toUpperCase().charCodeAt(0) - 'A'.charCodeAt(0);
  const row = parseInt(coord.slice(1), 10);
  const numColumns = 11;
  return (row - 1) * numColumns + colIndex + 1;
}

export function normalizeMoonBoardHolds(holds: MoonBoardHoldsInput): NormalizedMoonBoardHold[] {
  const holdsById = new Map<number, MoonBoardHoldState>();

  for (const { key, state } of MOONBOARD_COORDINATE_GROUPS) {
    for (const rawCoord of holds[key] ?? []) {
      const coord = rawCoord.trim().toUpperCase();
      if (!coord) continue;
      holdsById.set(coordinateToHoldId(coord), state);
    }
  }

  return Array.from(holdsById.entries())
    .sort(([a], [b]) => a - b)
    .map(([holdId, holdState]) => ({ holdId, holdState }));
}

function buildMoonBoardHoldSignature(entries: NormalizedMoonBoardHold[]): string {
  return entries.map(({ holdId, holdState }) => `${holdId}:${holdState}`).join(',');
}

function buildMoonBoardHoldSignatureFromFrames(frames: string | null | undefined): string {
  if (!frames) return '';

  const parsedFrame = convertLitUpHoldsStringToMap(frames, 'moonboard')[0] || {};
  const entries = Object.entries(parsedFrame)
    .map(([holdId, hold]) => {
      if (hold.state === 'STARTING' || hold.state === 'HAND' || hold.state === 'FINISH') {
        return { holdId: Number(holdId), holdState: hold.state };
      }
      return null;
    })
    .filter((entry): entry is NormalizedMoonBoardHold => entry !== null)
    .sort((a, b) => a.holdId - b.holdId);

  return buildMoonBoardHoldSignature(entries);
}

export function encodeMoonBoardHoldsToFrames(holds: MoonBoardHoldsInput): string {
  return normalizeMoonBoardHolds(holds)
    .map(({ holdId, holdState }) => `p${holdId}r${MOONBOARD_ROLE_CODE_BY_STATE[holdState]}`)
    .join('');
}

export function buildMoonBoardClimbHoldRows(climbUuid: string, holds: MoonBoardHoldsInput) {
  return normalizeMoonBoardHolds(holds).map(({ holdId, holdState }) => ({
    boardType: 'moonboard' as const,
    climbUuid,
    holdId,
    frameNumber: 0,
    holdState,
  })) satisfies Array<typeof dbSchema.boardClimbHolds.$inferInsert>;
}

type DuplicateMatchRow = {
  uuid: string;
  name: string | null;
  ascensionistCount: number;
};

function shouldReplaceMatch(current: DuplicateMatchRow | undefined, next: DuplicateMatchRow): boolean {
  if (!current) return true;
  if (next.ascensionistCount !== current.ascensionistCount) {
    return next.ascensionistCount > current.ascensionistCount;
  }
  return next.uuid < current.uuid;
}

export function buildMoonBoardDuplicateError(existingClimbName?: string | null): string {
  if (existingClimbName?.trim()) {
    return `${MOONBOARD_DUPLICATE_ERROR_PREFIX}: "${existingClimbName.trim()}"`;
  }
  return MOONBOARD_DUPLICATE_ERROR_PREFIX;
}

export async function findMoonBoardDuplicateMatches(
  layoutId: number,
  angle: number,
  climbs: DuplicateCandidate[],
): Promise<MoonBoardClimbDuplicateMatch[]> {
  if (climbs.length === 0) return [];

  const candidateSignatures = climbs.map((climb) => ({
    clientKey: climb.clientKey,
    signature: buildMoonBoardHoldSignature(normalizeMoonBoardHolds(climb.holds)),
  }));

  const uniqueSignatures = Array.from(
    new Set(candidateSignatures.map((candidate) => candidate.signature).filter((signature) => signature.length > 0)),
  );

  const bestMatchBySignature = new Map<string, DuplicateMatchRow>();

  if (uniqueSignatures.length > 0) {
    const signatureValues = sql.join(
      uniqueSignatures.map((signature) => sql`${signature}`),
      sql`, `,
    );
    const exactMatchRows = await executeRows<DuplicateLookupRow>(
      db,
      sql`
      SELECT
        ${dbSchema.boardClimbs.uuid} AS uuid,
        ${dbSchema.boardClimbs.name} AS name,
        COALESCE(${dbSchema.boardClimbStats.ascensionistCount}, 0) AS ascensionist_count,
        string_agg(
          ${dbSchema.boardClimbHolds.holdId}::text || ':' || ${dbSchema.boardClimbHolds.holdState},
          ',' ORDER BY ${dbSchema.boardClimbHolds.holdId}
        ) AS signature
      FROM ${dbSchema.boardClimbs}
      INNER JOIN ${dbSchema.boardClimbHolds}
        ON ${dbSchema.boardClimbHolds.climbUuid} = ${dbSchema.boardClimbs.uuid}
       AND ${dbSchema.boardClimbHolds.boardType} = ${dbSchema.boardClimbs.boardType}
      LEFT JOIN ${dbSchema.boardClimbStats}
        ON ${dbSchema.boardClimbStats.boardType} = ${dbSchema.boardClimbs.boardType}
       AND ${dbSchema.boardClimbStats.climbUuid} = ${dbSchema.boardClimbs.uuid}
       AND ${dbSchema.boardClimbStats.angle} = ${dbSchema.boardClimbs.angle}
      WHERE ${dbSchema.boardClimbs.boardType} = 'moonboard'
        AND ${dbSchema.boardClimbs.layoutId} = ${layoutId}
        AND ${dbSchema.boardClimbs.angle} = ${angle}
        AND ${dbSchema.boardClimbs.isListed} = true
        AND ${dbSchema.boardClimbs.isDraft} = false
      GROUP BY
        ${dbSchema.boardClimbs.uuid},
        ${dbSchema.boardClimbs.name},
        ${dbSchema.boardClimbStats.ascensionistCount}
      HAVING string_agg(
        ${dbSchema.boardClimbHolds.holdId}::text || ':' || ${dbSchema.boardClimbHolds.holdState},
        ',' ORDER BY ${dbSchema.boardClimbHolds.holdId}
      ) IN (${signatureValues})
      ORDER BY COALESCE(${dbSchema.boardClimbStats.ascensionistCount}, 0) DESC, ${dbSchema.boardClimbs.uuid} ASC
    `,
    );

    for (const row of exactMatchRows) {
      const next = {
        uuid: row.uuid,
        name: row.name,
        ascensionistCount: Number(row.ascensionist_count || 0),
      };
      const current = bestMatchBySignature.get(row.signature);
      if (shouldReplaceMatch(current, next)) {
        bestMatchBySignature.set(row.signature, next);
      }
    }

    const legacyRows = await executeRows<LegacyDuplicateLookupRow>(
      db,
      sql`
      SELECT
        ${dbSchema.boardClimbs.uuid} AS uuid,
        ${dbSchema.boardClimbs.name} AS name,
        ${dbSchema.boardClimbs.frames} AS frames,
        COALESCE(${dbSchema.boardClimbStats.ascensionistCount}, 0) AS ascensionist_count
      FROM ${dbSchema.boardClimbs}
      LEFT JOIN ${dbSchema.boardClimbStats}
        ON ${dbSchema.boardClimbStats.boardType} = ${dbSchema.boardClimbs.boardType}
       AND ${dbSchema.boardClimbStats.climbUuid} = ${dbSchema.boardClimbs.uuid}
       AND ${dbSchema.boardClimbStats.angle} = ${dbSchema.boardClimbs.angle}
      WHERE ${dbSchema.boardClimbs.boardType} = 'moonboard'
        AND ${dbSchema.boardClimbs.layoutId} = ${layoutId}
        AND ${dbSchema.boardClimbs.angle} = ${angle}
        AND ${dbSchema.boardClimbs.isListed} = true
        AND ${dbSchema.boardClimbs.isDraft} = false
        AND NOT EXISTS (
          SELECT 1
          FROM ${dbSchema.boardClimbHolds} legacy_holds
          WHERE legacy_holds.board_type = ${dbSchema.boardClimbs.boardType}
            AND legacy_holds.climb_uuid = ${dbSchema.boardClimbs.uuid}
        )
      ORDER BY COALESCE(${dbSchema.boardClimbStats.ascensionistCount}, 0) DESC, ${dbSchema.boardClimbs.uuid} ASC
    `,
    );

    for (const row of legacyRows) {
      const signature = buildMoonBoardHoldSignatureFromFrames(row.frames);
      if (!signature || !uniqueSignatures.includes(signature)) continue;

      const next = {
        uuid: row.uuid,
        name: row.name,
        ascensionistCount: Number(row.ascensionist_count || 0),
      };
      const current = bestMatchBySignature.get(signature);
      if (shouldReplaceMatch(current, next)) {
        bestMatchBySignature.set(signature, next);
      }
    }
  }

  return candidateSignatures.map(({ clientKey, signature }) => {
    const match = bestMatchBySignature.get(signature);
    return {
      clientKey,
      exists: !!match,
      existingClimbUuid: match?.uuid ?? null,
      existingClimbName: match?.name ?? null,
    };
  });
}

export async function findMoonBoardDuplicateMatch(
  layoutId: number,
  angle: number,
  holds: MoonBoardHoldsInput,
): Promise<MoonBoardClimbDuplicateMatch | null> {
  const [match] = await findMoonBoardDuplicateMatches(layoutId, angle, [{ clientKey: 'save', holds }]);
  return match?.exists ? match : null;
}
