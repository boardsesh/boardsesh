import { and, asc, eq, sql } from 'drizzle-orm';
import {
  boardClimbAliases,
  boardClimbs,
  boardDifficultyGrades,
  boardseshTicks,
  playlistClimbs,
  playlistOwnership,
  playlists,
  userFavorites,
  users,
} from '@boardsesh/db/schema';
import type { AuroraBoardName } from '@boardsesh/shared-schema';
import { dbRead } from '../db/client';
import { getFromS3, getS3ObjectMetadata, isS3Configured, uploadToS3 } from '../storage/s3';
import {
  buildAuroraJsonExport,
  getIsoWeekPeriod,
  getUserDataExportFilename,
  getUserDataExportS3Key,
  type AuroraJsonExport,
} from './user-data-export-format';
import { logger } from '../utils/logger';

export type UserDataExportStatus = {
  boardType: AuroraBoardName;
  period: string;
  status: 'not_requested' | 'generating' | 'ready' | 'failed' | 'unavailable';
  requestedAt?: string;
  completedAt?: string;
  downloadUrl?: string;
  fileSize?: number;
  error?: string;
};

type ExportJob = UserDataExportStatus & {
  userId: string;
  key: string;
  jobId: string;
};

type CachedExportJob = ExportJob & {
  updatedAtMs: number;
};

export type DownloadableUserDataExport = {
  key: string;
  filename: string;
  stream: NonNullable<Awaited<ReturnType<typeof getFromS3>>>['stream'];
  contentType: string | undefined;
  contentLength: number | undefined;
};

const exportJobs = new Map<string, CachedExportJob>();
const PUBLIC_EXPORT_FAILURE_MESSAGE = 'Export generation failed. Try again later.';
const PUBLIC_EXPORT_UNAVAILABLE_MESSAGE = 'Export service is temporarily unavailable.';
const EXPORT_JOB_CACHE_TTL_MS = 8 * 24 * 60 * 60 * 1000;
const EXPORT_JOB_CACHE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const exportJobCleanupInterval = setInterval(() => {
  evictStaleExportJobs();
}, EXPORT_JOB_CACHE_SWEEP_INTERVAL_MS);

if (typeof exportJobCleanupInterval.unref === 'function') {
  exportJobCleanupInterval.unref();
}

export async function getUserDataExportStatus(
  userId: string,
  boardType: AuroraBoardName,
): Promise<UserDataExportStatus> {
  evictStaleExportJobs();

  const descriptor = getCurrentExportDescriptor(userId, boardType);
  const existing = exportJobs.get(descriptor.jobId);
  if (existing) return toPublicStatus(existing);

  if (!isS3Configured()) {
    return {
      boardType,
      period: descriptor.period,
      status: 'unavailable',
      error: PUBLIC_EXPORT_UNAVAILABLE_MESSAGE,
    };
  }

  const metadata = await getS3ObjectMetadata(descriptor.key);
  if (!metadata) {
    return {
      boardType,
      period: descriptor.period,
      status: 'not_requested',
    };
  }

  const readyJob: ExportJob = {
    userId,
    key: descriptor.key,
    jobId: descriptor.jobId,
    boardType,
    period: descriptor.period,
    status: 'ready',
    completedAt: metadata.lastModified?.toISOString(),
    downloadUrl: descriptor.downloadUrl,
    fileSize: metadata.contentLength,
  };
  storeExportJob(readyJob);
  return toPublicStatus(readyJob);
}

export async function requestUserDataExport(userId: string, boardType: AuroraBoardName): Promise<UserDataExportStatus> {
  evictStaleExportJobs();

  const descriptor = getCurrentExportDescriptor(userId, boardType);
  const existing = exportJobs.get(descriptor.jobId);

  if (existing?.status === 'generating' || existing?.status === 'ready') {
    return toPublicStatus(existing);
  }

  if (!isS3Configured()) {
    return {
      boardType,
      period: descriptor.period,
      status: 'unavailable',
      error: PUBLIC_EXPORT_UNAVAILABLE_MESSAGE,
    };
  }

  const metadata = await getS3ObjectMetadata(descriptor.key);
  if (metadata) {
    const readyJob: ExportJob = {
      userId,
      key: descriptor.key,
      jobId: descriptor.jobId,
      boardType,
      period: descriptor.period,
      status: 'ready',
      completedAt: metadata.lastModified?.toISOString(),
      downloadUrl: descriptor.downloadUrl,
      fileSize: metadata.contentLength,
    };
    storeExportJob(readyJob);
    return toPublicStatus(readyJob);
  }

  const generatingJob: ExportJob = {
    userId,
    key: descriptor.key,
    jobId: descriptor.jobId,
    boardType,
    period: descriptor.period,
    status: 'generating',
    requestedAt: new Date().toISOString(),
  };
  storeExportJob(generatingJob);

  void generateAndStoreUserDataExport(generatingJob, descriptor.downloadUrl);

  return toPublicStatus(generatingJob);
}

export async function getDownloadableUserDataExport(
  userId: string,
  boardType: AuroraBoardName,
): Promise<DownloadableUserDataExport | null> {
  if (!isS3Configured()) return null;

  const descriptor = getCurrentExportDescriptor(userId, boardType);
  const file = await getFromS3(descriptor.key);
  if (!file) return null;

  return {
    key: descriptor.key,
    filename: getUserDataExportFilename(boardType),
    stream: file.stream,
    contentType: file.contentType,
    contentLength: file.contentLength,
  };
}

export async function buildUserAuroraJsonExport(userId: string, boardType: AuroraBoardName): Promise<AuroraJsonExport> {
  const [userRows, tickRows, favoriteRows, circuitRows, climbRows] = await Promise.all([
    dbRead
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
    dbRead
      .select({
        climbName: boardClimbs.name,
        status: boardseshTicks.status,
        angle: boardseshTicks.angle,
        attemptCount: boardseshTicks.attemptCount,
        quality: boardseshTicks.quality,
        difficulty: boardseshTicks.difficulty,
        difficultyName: boardDifficultyGrades.boulderName,
        climbedAt: boardseshTicks.climbedAt,
        createdAt: boardseshTicks.createdAt,
      })
      .from(boardseshTicks)
      // Resolve dedup-merged climbs to their canonical UUID before joining
      // board_climbs. A tick may point at an alias UUID that was deduplicated
      // away (no board_climbs row); the alias table maps it to the canonical.
      // Ticks already on a canonical have no alias row, so COALESCE falls back
      // to the tick's own climb_uuid. The PK (board_type, alias_uuid) keeps this
      // join to ≤1 row, so it never fans out.
      .leftJoin(
        boardClimbAliases,
        and(
          eq(boardseshTicks.climbUuid, boardClimbAliases.aliasUuid),
          eq(boardseshTicks.boardType, boardClimbAliases.boardType),
        ),
      )
      // LEFT (not INNER): a data export must never silently drop a tick, even if
      // its climb is somehow absent from board_climbs. climbName stays null then.
      .leftJoin(
        boardClimbs,
        and(
          eq(boardseshTicks.boardType, boardClimbs.boardType),
          sql`COALESCE(${boardClimbAliases.canonicalUuid}, ${boardseshTicks.climbUuid}) = ${boardClimbs.uuid}`,
        ),
      )
      .leftJoin(
        boardDifficultyGrades,
        and(
          eq(boardseshTicks.boardType, boardDifficultyGrades.boardType),
          eq(boardseshTicks.difficulty, boardDifficultyGrades.difficulty),
        ),
      )
      .where(and(eq(boardseshTicks.userId, userId), eq(boardseshTicks.boardType, boardType)))
      .orderBy(asc(boardseshTicks.climbedAt), asc(boardseshTicks.createdAt), asc(boardseshTicks.uuid)),
    dbRead
      .select({
        climbName: boardClimbs.name,
        createdAt: userFavorites.createdAt,
      })
      .from(userFavorites)
      .innerJoin(boardClimbs, and(eq(boardClimbs.boardType, boardType), eq(userFavorites.climbUuid, boardClimbs.uuid)))
      .where(eq(userFavorites.userId, userId))
      .orderBy(asc(userFavorites.createdAt)),
    dbRead
      .select({
        playlistId: playlists.id,
        name: playlists.name,
        color: playlists.color,
        createdAt: playlists.createdAt,
        description: playlists.description,
        isPublic: playlists.isPublic,
        climbName: boardClimbs.name,
        position: playlistClimbs.position,
      })
      .from(playlists)
      .innerJoin(
        playlistOwnership,
        and(eq(playlistOwnership.playlistId, playlists.id), eq(playlistOwnership.userId, userId)),
      )
      .leftJoin(playlistClimbs, eq(playlistClimbs.playlistId, playlists.id))
      .leftJoin(
        boardClimbs,
        and(eq(playlists.boardType, boardClimbs.boardType), eq(playlistClimbs.climbUuid, boardClimbs.uuid)),
      )
      .where(and(eq(playlists.boardType, boardType), eq(playlistOwnership.role, 'owner')))
      .orderBy(asc(playlists.createdAt), asc(playlistClimbs.position)),
    dbRead
      .select({
        uuid: boardClimbs.uuid,
        name: boardClimbs.name,
        layoutId: boardClimbs.layoutId,
        frames: boardClimbs.frames,
        createdAt: boardClimbs.createdAt,
        isDraft: boardClimbs.isDraft,
        description: boardClimbs.description,
      })
      .from(boardClimbs)
      .where(and(eq(boardClimbs.userId, userId), eq(boardClimbs.boardType, boardType)))
      .orderBy(asc(boardClimbs.createdAt), asc(boardClimbs.uuid)),
  ]);

  return buildAuroraJsonExport({
    boardType,
    user: userRows[0] ?? null,
    ticks: tickRows,
    favorites: favoriteRows,
    circuitRows,
    climbs: climbRows,
  });
}

async function generateAndStoreUserDataExport(job: ExportJob, downloadUrl: string): Promise<void> {
  try {
    const payload = await buildUserAuroraJsonExport(job.userId, job.boardType);
    const buffer = Buffer.from(JSON.stringify(payload, null, 2));

    await uploadToS3(buffer, job.key, 'application/json', {
      cacheControl: 'private, no-store',
      acl: null,
    });

    storeExportJob({
      ...job,
      status: 'ready',
      completedAt: new Date().toISOString(),
      downloadUrl,
      fileSize: buffer.length,
      error: undefined,
    });
  } catch (error) {
    logger.error('[User Data Export] Export generation failed:', error);
    storeExportJob({
      ...job,
      status: 'failed',
      error: PUBLIC_EXPORT_FAILURE_MESSAGE,
    });
  }
}

function getCurrentExportDescriptor(userId: string, boardType: AuroraBoardName) {
  const period = getIsoWeekPeriod().label;
  const key = getUserDataExportS3Key(userId, boardType);
  const downloadUrl = `/api/user-data-export/download?boardType=${encodeURIComponent(boardType)}`;

  return {
    period,
    key,
    jobId: getJobId(userId, boardType),
    downloadUrl,
  };
}

function getJobId(userId: string, boardType: AuroraBoardName): string {
  const period = getIsoWeekPeriod().label;
  return `${userId}:${boardType}:${period}`;
}

function storeExportJob(job: ExportJob): CachedExportJob {
  const exportJob = { ...job, updatedAtMs: Date.now() };
  exportJobs.set(exportJob.jobId, exportJob);
  return exportJob;
}

function evictStaleExportJobs(now = Date.now()): void {
  const staleBefore = now - EXPORT_JOB_CACHE_TTL_MS;

  for (const [jobId, job] of exportJobs) {
    if (job.updatedAtMs <= staleBefore) {
      exportJobs.delete(jobId);
    }
  }
}

function toPublicStatus(job: ExportJob): UserDataExportStatus {
  return {
    boardType: job.boardType,
    period: job.period,
    status: job.status,
    requestedAt: job.requestedAt,
    completedAt: job.completedAt,
    downloadUrl: job.downloadUrl,
    fileSize: job.fileSize,
    error: job.error,
  };
}
