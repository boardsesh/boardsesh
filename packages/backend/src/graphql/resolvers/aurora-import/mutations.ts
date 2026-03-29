import { z } from 'zod';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'crypto';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { createPool } from '@boardsesh/db/client';
import { drizzle } from 'drizzle-orm/neon-serverless';
import type { NeonDatabase } from 'drizzle-orm/neon-serverless';
import { db } from '../../../db/client';
import { requireAuthenticated } from '../shared/helpers';
import { fontGradeToDifficultyId } from '../../../utils/boulder-grades';
import { runInferredSessionBuilderBatched } from '../../../jobs/inferred-session-builder';

// ---------------------------------------------------------------------------
// Zod schemas for the Aurora JSON export format
// ---------------------------------------------------------------------------

const auroraExportAscentSchema = z.object({
  climb: z.string(),
  angle: z.number(),
  count: z.number(),
  stars: z.number(),
  climbed_at: z.string(),
  created_at: z.string(),
  grade: z.string(),
});

const auroraExportAttemptSchema = z.object({
  climb: z.string(),
  angle: z.number(),
  count: z.number(),
  climbed_at: z.string(),
  created_at: z.string(),
});

const auroraExportCircuitSchema = z.object({
  name: z.string(),
  color: z.string(),
  created_at: z.string(),
  climbs: z.array(z.string()),
});

const auroraExportSchema = z.object({
  user: z.object({
    username: z.string(),
    email_address: z.string().optional(),
    created_at: z.string().optional(),
  }),
  ascents: z.array(auroraExportAscentSchema).default([]),
  attempts: z.array(auroraExportAttemptSchema).default([]),
  circuits: z.array(auroraExportCircuitSchema).default([]),
  // Fields we don't import but should accept without error
  likes: z.array(z.unknown()).optional(),
  follows: z.array(z.unknown()).optional(),
  walls: z.array(z.unknown()).optional(),
  blocks: z.array(z.unknown()).optional(),
  beta_links: z.array(z.unknown()).optional(),
  climbs: z.array(z.unknown()).optional(),
  agreements: z.array(z.unknown()).optional(),
});

const importInputSchema = z.object({
  boardType: z.enum(['kilter', 'tension']),
  data: auroraExportSchema,
});

type BoardType = 'kilter' | 'tension';

const BATCH_SIZE = 100;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ImportCounts {
  imported: number;
  skipped: number;
  failed: number;
}

export interface ImportResult {
  ascents: ImportCounts;
  attempts: ImportCounts;
  circuits: ImportCounts;
  unresolvedClimbs: string[];
  claimedUsername: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeTimestamp(ts: string): string {
  let normalized = ts.trim();
  if (!normalized.includes('T') && !normalized.includes('Z')) {
    normalized = normalized.replace(/(\.\d{3})\d*$/, '$1');
    normalized = normalized.replace(' ', 'T') + 'Z';
  }
  return new Date(normalized).toISOString();
}

function generateJsonImportAuroraId(
  userId: string,
  climbUuid: string,
  angle: number,
  climbedAt: string,
  type: 'ascents' | 'bids',
): string {
  const hash = createHash('sha256')
    .update(`${userId}:${climbUuid}:${angle}:${climbedAt}:${type}`)
    .digest('hex')
    .slice(0, 32);
  return `json-import-${hash}`;
}

// ---------------------------------------------------------------------------
// Climb name resolution
// ---------------------------------------------------------------------------

async function resolveClimbNames(
  conn: NeonDatabase<Record<string, never>>,
  boardType: BoardType,
  climbNames: string[],
): Promise<Map<string, string>> {
  if (climbNames.length === 0) return new Map();

  const nameToMatch = new Map<string, { uuid: string; count: number }>();
  const chunkSize = 500;

  for (let i = 0; i < climbNames.length; i += chunkSize) {
    const chunk = climbNames.slice(i, i + chunkSize);

    const results = await conn
      .select({
        uuid: dbSchema.boardClimbs.uuid,
        name: dbSchema.boardClimbs.name,
        ascensionistCount: dbSchema.boardClimbStats.ascensionistCount,
      })
      .from(dbSchema.boardClimbs)
      .leftJoin(
        dbSchema.boardClimbStats,
        and(
          eq(dbSchema.boardClimbStats.climbUuid, dbSchema.boardClimbs.uuid),
          eq(dbSchema.boardClimbStats.boardType, dbSchema.boardClimbs.boardType),
        ),
      )
      .where(
        and(
          eq(dbSchema.boardClimbs.boardType, boardType),
          inArray(dbSchema.boardClimbs.name, chunk),
          eq(dbSchema.boardClimbs.isListed, true),
          eq(dbSchema.boardClimbs.isDraft, false),
        ),
      );

    for (const row of results) {
      if (!row.name) continue;
      const count = row.ascensionistCount ?? 0;
      const existing = nameToMatch.get(row.name);
      if (!existing || count > existing.count) {
        nameToMatch.set(row.name, { uuid: row.uuid, count });
      }
    }
  }

  return new Map([...nameToMatch].map(([name, match]) => [name, match.uuid]));
}

// ---------------------------------------------------------------------------
// Cross-source dedup
// ---------------------------------------------------------------------------

async function getExistingTickKeys(
  conn: NeonDatabase<Record<string, never>>,
  userId: string,
  boardType: BoardType,
): Promise<Set<string>> {
  const existing = await conn
    .select({
      climbUuid: dbSchema.boardseshTicks.climbUuid,
      angle: dbSchema.boardseshTicks.angle,
      climbedAt: dbSchema.boardseshTicks.climbedAt,
    })
    .from(dbSchema.boardseshTicks)
    .where(
      and(
        eq(dbSchema.boardseshTicks.userId, userId),
        eq(dbSchema.boardseshTicks.boardType, boardType),
      ),
    );

  return new Set(
    existing.map((row) => {
      const normalized = normalizeTimestamp(row.climbedAt);
      return `${row.climbUuid}:${row.angle}:${normalized}`;
    }),
  );
}

// ---------------------------------------------------------------------------
// Batch insert helper
// ---------------------------------------------------------------------------

async function batchInsertTicks(
  conn: NeonDatabase<Record<string, never>>,
  rows: (typeof dbSchema.boardseshTicks.$inferInsert)[],
  conflictSet: Record<string, ReturnType<typeof sql>>,
): Promise<number> {
  if (rows.length === 0) return 0;

  let imported = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    await conn
      .insert(dbSchema.boardseshTicks)
      .values(batch)
      .onConflictDoUpdate({
        target: dbSchema.boardseshTicks.auroraId,
        set: conflictSet,
      });
    imported += batch.length;
  }
  return imported;
}

// ---------------------------------------------------------------------------
// Username claim
// ---------------------------------------------------------------------------

async function upsertUsernameClaim(
  userId: string,
  boardType: BoardType,
  auroraUsername: string,
): Promise<void> {
  await db
    .insert(dbSchema.auroraUsernameClaims)
    .values({
      userId,
      boardType,
      auroraUsername,
    })
    .onConflictDoUpdate({
      target: [dbSchema.auroraUsernameClaims.userId, dbSchema.auroraUsernameClaims.boardType],
      set: {
        auroraUsername,
        claimedAt: new Date(),
      },
    });
}

// ---------------------------------------------------------------------------
// Main import function
// ---------------------------------------------------------------------------

async function importJsonExportData(
  userId: string,
  boardType: BoardType,
  data: z.infer<typeof auroraExportSchema>,
): Promise<ImportResult> {
  const result: ImportResult = {
    ascents: { imported: 0, skipped: 0, failed: 0 },
    attempts: { imported: 0, skipped: 0, failed: 0 },
    circuits: { imported: 0, skipped: 0, failed: 0 },
    unresolvedClimbs: [],
    claimedUsername: null,
  };

  const now = new Date().toISOString();

  // Store the Aurora username claim
  const auroraUsername = data.user.username;
  if (auroraUsername) {
    await upsertUsernameClaim(userId, boardType, auroraUsername);
    result.claimedUsername = auroraUsername;
  }

  // Collect all unique climb names
  const allClimbNames = new Set([
    ...data.ascents.map((a) => a.climb),
    ...data.attempts.map((a) => a.climb),
    ...data.circuits.flatMap((c) => c.climbs),
  ]);

  const pool = createPool();
  const client = await pool.connect();

  try {
    const conn = drizzle(client);

    // Resolve climb names to UUIDs
    const nameToUuid = await resolveClimbNames(conn, boardType, [...allClimbNames]);
    result.unresolvedClimbs = [...allClimbNames].filter((name) => !nameToUuid.has(name));

    // Get existing tick keys for dedup
    const existingKeys = await getExistingTickKeys(conn, userId, boardType);

    // Build ascent rows
    type TickRow = typeof dbSchema.boardseshTicks.$inferInsert;

    const ascentRows = data.ascents.reduce<TickRow[]>((rows, ascent) => {
      const climbUuid = nameToUuid.get(ascent.climb);
      if (!climbUuid) { result.ascents.failed++; return rows; }

      const climbedAt = normalizeTimestamp(ascent.climbed_at);
      const tickKey = `${climbUuid}:${ascent.angle}:${climbedAt}`;
      if (existingKeys.has(tickKey)) { result.ascents.skipped++; return rows; }

      existingKeys.add(tickKey);
      rows.push({
        uuid: randomUUID(),
        userId,
        boardType,
        climbUuid,
        angle: ascent.angle,
        isMirror: false,
        status: ascent.count === 1 ? 'flash' : 'send',
        attemptCount: ascent.count,
        quality: ascent.stars,
        difficulty: fontGradeToDifficultyId(ascent.grade),
        isBenchmark: false,
        comment: '',
        climbedAt,
        createdAt: ascent.created_at ? normalizeTimestamp(ascent.created_at) : now,
        updatedAt: now,
        auroraType: 'ascents' as const,
        auroraId: generateJsonImportAuroraId(userId, climbUuid, ascent.angle, climbedAt, 'ascents'),
        auroraSyncedAt: now,
      });
      return rows;
    }, []);

    // Build attempt rows
    const attemptRows = data.attempts.reduce<TickRow[]>((rows, attempt) => {
      const climbUuid = nameToUuid.get(attempt.climb);
      if (!climbUuid) { result.attempts.failed++; return rows; }

      const climbedAt = normalizeTimestamp(attempt.climbed_at);
      const tickKey = `${climbUuid}:${attempt.angle}:${climbedAt}`;
      if (existingKeys.has(tickKey)) { result.attempts.skipped++; return rows; }

      existingKeys.add(tickKey);
      rows.push({
        uuid: randomUUID(),
        userId,
        boardType,
        climbUuid,
        angle: attempt.angle,
        isMirror: false,
        status: 'attempt',
        attemptCount: attempt.count,
        quality: null,
        difficulty: null,
        isBenchmark: false,
        comment: '',
        climbedAt,
        createdAt: attempt.created_at ? normalizeTimestamp(attempt.created_at) : now,
        updatedAt: now,
        auroraType: 'bids' as const,
        auroraId: generateJsonImportAuroraId(userId, climbUuid, attempt.angle, climbedAt, 'bids'),
        auroraSyncedAt: now,
      });
      return rows;
    }, []);

    // Batch-insert in a transaction
    await client.query('BEGIN');

    try {
      result.ascents.imported = await batchInsertTicks(
        conn, ascentRows,
        {
          climbUuid: sql`excluded.climb_uuid`,
          angle: sql`excluded.angle`,
          status: sql`excluded.status`,
          attemptCount: sql`excluded.attempt_count`,
          quality: sql`excluded.quality`,
          difficulty: sql`excluded.difficulty`,
          climbedAt: sql`excluded.climbed_at`,
          updatedAt: sql`excluded.updated_at`,
          auroraSyncedAt: sql`excluded.aurora_synced_at`,
        },
      );

      result.attempts.imported = await batchInsertTicks(
        conn, attemptRows,
        {
          climbUuid: sql`excluded.climb_uuid`,
          angle: sql`excluded.angle`,
          attemptCount: sql`excluded.attempt_count`,
          climbedAt: sql`excluded.climbed_at`,
          updatedAt: sql`excluded.updated_at`,
          auroraSyncedAt: sql`excluded.aurora_synced_at`,
        },
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }

    // Import circuits as playlists
    for (const circuit of data.circuits) {
      const resolvedClimbs = circuit.climbs
        .map((name) => nameToUuid.get(name))
        .filter((uuid): uuid is string => uuid != null);

      const circuitHash = createHash('sha256')
        .update(`${boardType}:${circuit.name}:${circuit.created_at}`)
        .digest('hex')
        .slice(0, 32);
      const circuitAuroraId = `json-import-circuit-${circuitHash}`;
      const formattedColor = circuit.color ? `#${circuit.color}` : null;
      const circuitNow = new Date();

      try {
        await client.query('BEGIN');

        const [playlist] = await conn
          .insert(dbSchema.playlists)
          .values({
            uuid: randomUUID(),
            boardType,
            layoutId: null,
            name: circuit.name,
            description: null,
            isPublic: false,
            color: formattedColor,
            auroraType: 'circuits',
            auroraId: circuitAuroraId,
            auroraSyncedAt: circuitNow,
            createdAt: circuit.created_at ? new Date(circuit.created_at) : circuitNow,
            updatedAt: circuitNow,
          })
          .onConflictDoUpdate({
            target: dbSchema.playlists.auroraId,
            set: {
              name: circuit.name,
              isPublic: false,
              color: formattedColor,
              updatedAt: circuitNow,
              auroraSyncedAt: circuitNow,
            },
          })
          .returning({ id: dbSchema.playlists.id });

        await conn
          .insert(dbSchema.playlistOwnership)
          .values({
            playlistId: playlist.id,
            userId,
            role: 'owner',
          })
          .onConflictDoNothing();

        if (resolvedClimbs.length > 0) {
          await conn.delete(dbSchema.playlistClimbs).where(eq(dbSchema.playlistClimbs.playlistId, playlist.id));

          const climbValues = resolvedClimbs.map((climbUuid, i) => ({
            playlistId: playlist.id,
            climbUuid,
            angle: null as number | null,
            position: i,
          }));

          for (let i = 0; i < climbValues.length; i += BATCH_SIZE) {
            await conn.insert(dbSchema.playlistClimbs).values(climbValues.slice(i, i + BATCH_SIZE));
          }
        }

        await client.query('COMMIT');
        result.circuits.imported++;
      } catch (error) {
        await client.query('ROLLBACK');
        console.error(`Failed to import circuit "${circuit.name}":`, error);
        result.circuits.failed++;
      }
    }

    // Build inferred sessions for imported ticks
    try {
      const sessionResult = await runInferredSessionBuilderBatched({ userId });
      if (sessionResult.ticksAssigned > 0) {
        console.log(`[AuroraImport] Built inferred sessions: assigned ${sessionResult.ticksAssigned} ticks for user ${userId}`);
      }
    } catch (error) {
      console.error('[AuroraImport] Error building inferred sessions:', error);
    }

    return result;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// GraphQL mutation resolver
// ---------------------------------------------------------------------------

export const auroraImportMutations = {
  importAuroraJson: async (
    _: unknown,
    { input }: { input: { boardType: string; data: unknown } },
    ctx: ConnectionContext,
  ): Promise<ImportResult> => {
    requireAuthenticated(ctx);

    const userId = ctx.userId!;

    // Validate input
    const parsed = importInputSchema.safeParse(input);
    if (!parsed.success) {
      const errors = parsed.error.flatten();
      throw new Error(`Invalid import data: ${JSON.stringify(errors.fieldErrors)}`);
    }

    const { boardType, data } = parsed.data;

    console.log(`[AuroraImport] Starting import for user ${userId}, board ${boardType}: ${data.ascents.length} ascents, ${data.attempts.length} attempts, ${data.circuits.length} circuits`);

    const result = await importJsonExportData(userId, boardType, data);

    console.log(`[AuroraImport] Complete for user ${userId}: ${result.ascents.imported} ascents, ${result.attempts.imported} attempts, ${result.circuits.imported} circuits imported`);

    return result;
  },
};
