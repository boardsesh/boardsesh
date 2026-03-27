import { db } from '../db/client';
import { eq } from 'drizzle-orm';
import {
  importJobs,
  boardseshTicks,
  userFavorites,
  playlists,
  playlistClimbs,
  playlistOwnership,
} from '@boardsesh/db/schema/app';
import { boardClimbs, boardDifficultyGrades } from '@boardsesh/db/schema/boards';
import { getFromS3 } from '../storage/s3';
import { redisClientManager } from '../redis/client';
import { importDataSchema, REDIS_IMPORT_STREAM, REDIS_IMPORT_GROUP } from './import-validation';
import { randomUUID } from 'crypto';

// Cache for climb name -> uuid lookups
type ClimbLookup = Map<string, string>; // lowercase name -> uuid

// Cache for grade name -> difficulty id
type GradeLookup = Map<string, number>; // lowercase grade name -> difficulty id

/**
 * Build a lookup map of climb names to UUIDs for a given board type
 */
async function buildClimbLookup(boardType: string): Promise<ClimbLookup> {
  const lookup: ClimbLookup = new Map();

  // Fetch all climbs for this board type (name + uuid)
  const climbs = await db
    .select({ uuid: boardClimbs.uuid, name: boardClimbs.name })
    .from(boardClimbs)
    .where(eq(boardClimbs.boardType, boardType));

  for (const climb of climbs) {
    if (climb.name) {
      // Use lowercase for case-insensitive matching
      const key = climb.name.toLowerCase();
      // If there are duplicates, keep the first one
      if (!lookup.has(key)) {
        lookup.set(key, climb.uuid);
      }
    }
  }

  return lookup;
}

/**
 * Build a lookup map of grade names to difficulty IDs for a given board type
 */
async function buildGradeLookup(boardType: string): Promise<GradeLookup> {
  const lookup: GradeLookup = new Map();

  const grades = await db
    .select({
      difficulty: boardDifficultyGrades.difficulty,
      boulderName: boardDifficultyGrades.boulderName
    })
    .from(boardDifficultyGrades)
    .where(eq(boardDifficultyGrades.boardType, boardType));

  for (const grade of grades) {
    if (grade.boulderName) {
      lookup.set(grade.boulderName.toLowerCase(), grade.difficulty);
    }
  }

  return lookup;
}

/**
 * Read an S3 object stream to a string
 */
async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Process a single import job
 */
async function processImportJob(jobId: string): Promise<void> {
  console.log(`[ImportWorker] Processing job ${jobId}`);

  // Fetch the job
  const [job] = await db
    .select()
    .from(importJobs)
    .where(eq(importJobs.id, BigInt(jobId)))
    .limit(1);

  if (!job) {
    console.error(`[ImportWorker] Job ${jobId} not found`);
    return;
  }

  if (job.status !== 'pending') {
    console.log(`[ImportWorker] Job ${jobId} is already ${job.status}, skipping`);
    return;
  }

  // Mark as processing
  await db
    .update(importJobs)
    .set({ status: 'processing', startedAt: new Date() })
    .where(eq(importJobs.id, BigInt(jobId)));

  const errors: string[] = [];
  const result: Record<string, number> = {};
  let processedItems = 0;

  try {
    // Download JSON from S3
    const s3Result = await getFromS3(job.s3Key);
    if (!s3Result) {
      throw new Error(`Failed to download import file from S3: ${job.s3Key}`);
    }

    const jsonStr = await streamToString(s3Result.stream);
    const rawData = JSON.parse(jsonStr);

    // Validate the data
    const parseResult = importDataSchema.safeParse(rawData);
    if (!parseResult.success) {
      throw new Error(`Invalid import data: ${parseResult.error.message}`);
    }

    const data = parseResult.data;
    const boardType = job.boardType;
    const userId = job.userId;

    // Calculate total items
    const totalItems =
      data.follows.length +
      data.circuits.length +
      data.likes.length +
      data.attempts.length +
      data.ascents.length +
      data.climbs.length;

    await db
      .update(importJobs)
      .set({ totalItems })
      .where(eq(importJobs.id, BigInt(jobId)));

    // Build lookup caches
    console.log(`[ImportWorker] Building climb lookup for ${boardType}...`);
    const climbLookup = await buildClimbLookup(boardType);
    console.log(`[ImportWorker] Loaded ${climbLookup.size} climbs`);

    const gradeLookup = await buildGradeLookup(boardType);
    console.log(`[ImportWorker] Loaded ${gradeLookup.size} grades`);

    // Helper to resolve climb name to UUID
    function resolveClimb(name: string): string | null {
      return climbLookup.get(name.toLowerCase()) || null;
    }

    // Helper to resolve grade string to difficulty ID
    function resolveGrade(grade: string): number | null {
      return gradeLookup.get(grade.toLowerCase()) || null;
    }

    // Process ascents (successful climbs -> ticks with status send/flash)
    let ascentsImported = 0;
    for (const ascent of data.ascents) {
      try {
        const climbUuid = resolveClimb(ascent.climb);
        if (!climbUuid) {
          errors.push(`Ascent: climb "${ascent.climb}" not found`);
          processedItems++;
          continue;
        }

        const difficulty = resolveGrade(ascent.grade);
        // Determine status: if count is 1, it could be a flash, otherwise send
        const status = ascent.count === 1 ? 'flash' : 'send';

        await db
          .insert(boardseshTicks)
          .values({
            uuid: randomUUID(),
            userId,
            boardType,
            climbUuid,
            angle: ascent.angle,
            status,
            attemptCount: ascent.count,
            quality: ascent.stars,
            difficulty,
            comment: ascent.comment || '',
            climbedAt: ascent.climbed_at,
            createdAt: ascent.created_at,
            updatedAt: ascent.created_at,
          })
          .onConflictDoNothing();

        ascentsImported++;
        processedItems++;
      } catch (err) {
        errors.push(`Ascent "${ascent.climb}": ${err instanceof Error ? err.message : String(err)}`);
        processedItems++;
      }
    }
    result.ascentsImported = ascentsImported;

    // Process attempts (failed attempts -> ticks with status attempt)
    let attemptsImported = 0;
    for (const attempt of data.attempts) {
      try {
        const climbUuid = resolveClimb(attempt.climb);
        if (!climbUuid) {
          errors.push(`Attempt: climb "${attempt.climb}" not found`);
          processedItems++;
          continue;
        }

        await db
          .insert(boardseshTicks)
          .values({
            uuid: randomUUID(),
            userId,
            boardType,
            climbUuid,
            angle: attempt.angle,
            status: 'attempt',
            attemptCount: attempt.count,
            climbedAt: attempt.climbed_at,
            createdAt: attempt.created_at,
            updatedAt: attempt.created_at,
          })
          .onConflictDoNothing();

        attemptsImported++;
        processedItems++;
      } catch (err) {
        errors.push(`Attempt "${attempt.climb}": ${err instanceof Error ? err.message : String(err)}`);
        processedItems++;
      }
    }
    result.attemptsImported = attemptsImported;

    // Process likes -> favorites
    let likesImported = 0;
    for (const like of data.likes) {
      try {
        const climbUuid = resolveClimb(like.climb);
        if (!climbUuid) {
          errors.push(`Like: climb "${like.climb}" not found`);
          processedItems++;
          continue;
        }

        // Likes don't have angle info, use 40 as default
        await db
          .insert(userFavorites)
          .values({
            userId,
            boardName: boardType,
            climbUuid,
            angle: 40,
            createdAt: new Date(like.created_at),
          })
          .onConflictDoNothing();

        likesImported++;
        processedItems++;
      } catch (err) {
        errors.push(`Like "${like.climb}": ${err instanceof Error ? err.message : String(err)}`);
        processedItems++;
      }
    }
    result.likesImported = likesImported;

    // Process circuits -> playlists
    let circuitsImported = 0;
    for (const circuit of data.circuits) {
      try {
        const playlistUuid = randomUUID();

        // Create the playlist
        const [newPlaylist] = await db
          .insert(playlists)
          .values({
            uuid: playlistUuid,
            boardType,
            name: circuit.name,
            color: circuit.color.startsWith('#') ? circuit.color : `#${circuit.color}`,
            isPublic: false,
            createdAt: new Date(circuit.created_at),
            updatedAt: new Date(circuit.created_at),
          })
          .returning();

        if (!newPlaylist) {
          errors.push(`Circuit "${circuit.name}": failed to create playlist`);
          processedItems++;
          continue;
        }

        // Create ownership
        await db
          .insert(playlistOwnership)
          .values({
            playlistId: newPlaylist.id,
            userId,
            role: 'owner',
          })
          .onConflictDoNothing();

        // Add climbs to playlist
        let position = 0;
        for (const climbName of circuit.climbs) {
          const climbUuid = resolveClimb(climbName);
          if (!climbUuid) {
            errors.push(`Circuit "${circuit.name}": climb "${climbName}" not found`);
            continue;
          }

          await db
            .insert(playlistClimbs)
            .values({
              playlistId: newPlaylist.id,
              climbUuid,
              position,
            })
            .onConflictDoNothing();

          position++;
        }

        circuitsImported++;
        processedItems++;
      } catch (err) {
        errors.push(`Circuit "${circuit.name}": ${err instanceof Error ? err.message : String(err)}`);
        processedItems++;
      }
    }
    result.circuitsImported = circuitsImported;

    // Update progress periodically
    await db
      .update(importJobs)
      .set({ processedItems, failedItems: errors.length })
      .where(eq(importJobs.id, BigInt(jobId)));

    // Mark as completed
    await db
      .update(importJobs)
      .set({
        status: 'completed',
        processedItems,
        failedItems: errors.length,
        errors: errors.slice(0, 500), // Cap stored errors at 500
        result,
        completedAt: new Date(),
      })
      .where(eq(importJobs.id, BigInt(jobId)));

    console.log(`[ImportWorker] Job ${jobId} completed: ${JSON.stringify(result)}`);

  } catch (err) {
    console.error(`[ImportWorker] Job ${jobId} failed:`, err);

    await db
      .update(importJobs)
      .set({
        status: 'failed',
        processedItems,
        failedItems: errors.length + 1,
        errors: [...errors, err instanceof Error ? err.message : String(err)].slice(0, 500),
        completedAt: new Date(),
      })
      .where(eq(importJobs.id, BigInt(jobId)));
  }
}

/**
 * Start the import worker loop
 * Uses Redis streams (XREADGROUP) for reliable job processing
 */
export async function startImportWorker(): Promise<void> {
  if (!redisClientManager.isRedisConnected()) {
    console.log('[ImportWorker] Redis not connected, import worker disabled');
    return;
  }

  const { publisher, streamConsumer } = redisClientManager.getClients();
  const consumerName = `worker-${process.pid}`;

  // Create consumer group (ignore error if it already exists)
  try {
    await publisher.xgroup('CREATE', REDIS_IMPORT_STREAM, REDIS_IMPORT_GROUP, '0', 'MKSTREAM');
    console.log(`[ImportWorker] Created consumer group ${REDIS_IMPORT_GROUP}`);
  } catch (err: unknown) {
    // BUSYGROUP means group already exists, which is fine
    if (err instanceof Error && !err.message.includes('BUSYGROUP')) {
      throw err;
    }
  }

  console.log(`[ImportWorker] Started (consumer: ${consumerName})`);

  // Process loop
  const processLoop = async () => {
    while (true) {
      try {
        // First, check for any pending (unacknowledged) messages
        const pending = await streamConsumer.xreadgroup(
          'GROUP', REDIS_IMPORT_GROUP, consumerName,
          'COUNT', '1',
          'BLOCK', '5000',
          'STREAMS', REDIS_IMPORT_STREAM, '>'
        );

        if (pending) {
          const streams = pending as Array<[string, Array<[string, string[]]>]>;
          for (const [, messages] of streams) {
            for (const [messageId, fields] of messages) {
              // fields is an array of [key, value, key, value, ...]
              const fieldMap: Record<string, string> = {};
              for (let i = 0; i < fields.length; i += 2) {
                fieldMap[fields[i]] = fields[i + 1];
              }

              const jobId = fieldMap.jobId;
              if (jobId) {
                await processImportJob(jobId);
              }

              // Acknowledge the message
              await publisher.xack(REDIS_IMPORT_STREAM, REDIS_IMPORT_GROUP, messageId);
            }
          }
        }
      } catch (err) {
        console.error('[ImportWorker] Error in process loop:', err);
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  };

  // Run in background (don't await)
  processLoop().catch(err => {
    console.error('[ImportWorker] Fatal error:', err);
  });
}

/**
 * Queue an import job by adding a message to the Redis stream
 */
export async function queueImportJob(jobId: string): Promise<void> {
  if (!redisClientManager.isRedisConnected()) {
    throw new Error('Redis not connected - cannot queue import jobs');
  }

  const { publisher } = redisClientManager.getClients();
  await publisher.xadd(REDIS_IMPORT_STREAM, '*', 'jobId', jobId);
  console.log(`[ImportWorker] Queued job ${jobId}`);
}
