import { and, desc, eq } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import type { DbInstance } from '@boardsesh/db/client';
import { reconcileBackgroundJobRun } from '@boardsesh/db/queries';
import { backgroundJobRuns, users } from '@boardsesh/db/schema';
import {
  SUPPORTED_BOARDS,
  type AuroraBoardName,
  type BoardName,
  type UserDataExportDownloadLink,
  type UserDataExportFile,
  type UserDataExportFormat,
  type UserDataExportStatus,
} from '@boardsesh/shared-schema';
import { db, dbRead } from '../db/client';
import {
  getFromS3Strict,
  getS3ObjectMetadataStrict,
  isS3Configured,
  presignGetObject,
  uploadToS3,
} from '../storage/s3';
import { getIsoWeekPeriod, isAuroraBoardType, type AuroraJsonExport } from './user-data-export-format';
import {
  buildAuroraExportFromArchive,
  buildUserDataArchive,
  type BoardseshUserDataArchive,
} from './user-data-export-archive';
import { getJobQueue } from './job-queue';
import { enabledBatchFamiliesOrNone } from './batch-schedules';
import { enqueueBackgroundJobOn } from '../workers/jobs';
import type { BackgroundJobContext } from '../workers/families/types';
import { logger } from '../utils/logger';

export type { UserDataExportStatus } from '@boardsesh/shared-schema';
export const USER_DATA_EXPORT_FAMILY = 'user-data-export';
export const USER_DATA_EXPORT_RETENTION_MS = 14 * 86400_000;
export const USER_DATA_EXPORT_RETRY_MS = 5 * 60_000;
const FAILURE_MESSAGE = 'Export generation failed. Try again later.';
const UNAVAILABLE_MESSAGE = 'Export service is temporarily unavailable.';
const NON_TERMINAL = new Set(['queued', 'running', 'retrying']);

type ExportRun = typeof backgroundJobRuns.$inferSelect;
export type UserDataExportJobPayload = { userId: string; boardType: BoardName; period: string };
export type DownloadableUserDataExport = {
  key: string;
  filename: string;
  stream: NonNullable<Awaited<ReturnType<typeof getFromS3Strict>>>['stream'];
  contentType: string | undefined;
  contentLength: number | undefined;
};

export function isExportBoardType(boardType: string): boardType is BoardName {
  return (SUPPORTED_BOARDS as readonly string[]).includes(boardType);
}

export async function requireExportUser(userId: string, database: Pick<DbInstance, 'select'> = db): Promise<void> {
  const [user] = await database.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new GraphQLError('Authentication required', { extensions: { code: 'UNAUTHENTICATED' } });
}

/** Reject malformed/nonexistent ISO weeks and bound the private-object lookup. */
export function exportPeriodStart(period: string): Date {
  const match = /^(\d{4})-W(\d{2})$/.exec(period);
  if (!match) throw new GraphQLError('Invalid export period', { extensions: { code: 'BAD_USER_INPUT' } });
  const year = Number(match[1]);
  const week = Number(match[2]);
  const januaryFourth = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(
    januaryFourth.getTime() - ((januaryFourth.getUTCDay() || 7) - 1) * 86400_000 + (week - 1) * 7 * 86400_000,
  );
  if (getIsoWeekPeriod(monday).label !== period)
    throw new GraphQLError('Invalid export period', { extensions: { code: 'BAD_USER_INPUT' } });
  return monday;
}

export function userDataExportKey(
  userId: string,
  boardType: BoardName,
  period: string,
  format: UserDataExportFormat,
): string {
  return `user-data-exports/${userId}/${boardType}/${period}${format === 'boardsesh' ? '.boardsesh' : ''}.json`;
}
export function userDataExportFilename(boardType: BoardName, period: string, format: UserDataExportFormat): string {
  return `boardsesh-${boardType}-${format === 'boardsesh' ? 'archive' : 'export'}-${period}.json`;
}
export function userDataExportSingletonKey({ userId, boardType, period }: UserDataExportJobPayload): string {
  return `${userId}:${boardType}:${period}`;
}
const expectedFormats = (boardType: BoardName): UserDataExportFormat[] =>
  isAuroraBoardType(boardType) ? ['boardsesh', 'aurora'] : ['boardsesh'];
const refreshAt = (period: string) => new Date(exportPeriodStart(period).getTime() + 7 * 86400_000).toISOString();

async function readFiles(payload: UserDataExportJobPayload): Promise<UserDataExportFile[]> {
  const files = await Promise.all(
    expectedFormats(payload.boardType).map(async (format): Promise<UserDataExportFile | null> => {
      const metadata = await getS3ObjectMetadataStrict(
        'private',
        userDataExportKey(payload.userId, payload.boardType, payload.period, format),
      );
      if (!metadata) return null;
      const exportedAt = metadata.metadata?.['exported-at'] ?? metadata.lastModified?.toISOString();
      if (!exportedAt || !Number.isFinite(Date.parse(exportedAt))) throw new Error('EXPORT_METADATA_INVALID');
      const expiresAt = new Date(Date.parse(exportedAt) + USER_DATA_EXPORT_RETENTION_MS).toISOString();
      if (Date.parse(expiresAt) <= Date.now()) return null;
      return {
        format,
        filename: userDataExportFilename(payload.boardType, payload.period, format),
        fileSize: metadata.contentLength,
        exportedAt,
        expiresAt,
      };
    }),
  );
  return files.filter((file): file is UserDataExportFile => file !== null);
}

async function readRuns(database: Pick<DbInstance, 'select'>, payload: UserDataExportJobPayload): Promise<ExportRun[]> {
  return database
    .select()
    .from(backgroundJobRuns)
    .where(
      and(
        eq(backgroundJobRuns.family, USER_DATA_EXPORT_FAMILY),
        eq(backgroundJobRuns.singletonKey, userDataExportSingletonKey(payload)),
      ),
    )
    .orderBy(desc(backgroundJobRuns.createdAt), desc(backgroundJobRuns.id))
    .limit(2);
}

function exportStatus(
  payload: UserDataExportJobPayload,
  files: UserDataExportFile[],
  runs: ExportRun[],
): UserDataExportStatus {
  const latest = runs[0];
  const complete = files.length === expectedFormats(payload.boardType).length;
  const status = complete
    ? 'ready'
    : latest && NON_TERMINAL.has(latest.status)
      ? 'generating'
      : latest
        ? 'failed'
        : 'not_requested';
  const aurora = files.find((file) => file.format === 'aurora');
  const retryAt =
    status === 'failed'
      ? runs.length >= 2
        ? refreshAt(payload.period)
        : latest
          ? new Date((latest.finishedAt ?? latest.createdAt).getTime() + USER_DATA_EXPORT_RETRY_MS).toISOString()
          : undefined
      : undefined;
  return {
    boardType: payload.boardType,
    period: payload.period,
    status,
    files,
    refreshAt: refreshAt(payload.period),
    requestedAt: latest?.createdAt.toISOString(),
    completedAt: complete ? files[0]?.exportedAt : undefined,
    retryAt,
    error: status === 'failed' ? FAILURE_MESSAGE : undefined,
    ...(aurora
      ? {
          downloadUrl: `/api/user-data-export/download?boardType=${encodeURIComponent(payload.boardType)}&period=${payload.period}`,
          fileSize: aurora.fileSize,
        }
      : {}),
  };
}
const unavailableStatus = (payload: UserDataExportJobPayload): UserDataExportStatus => ({
  boardType: payload.boardType,
  period: payload.period,
  status: 'unavailable',
  files: [],
  refreshAt: refreshAt(payload.period),
  error: UNAVAILABLE_MESSAGE,
});

export async function getUserDataExportStatus(
  userId: string,
  boardType: BoardName,
  period?: string | null,
): Promise<UserDataExportStatus> {
  await requireExportUser(userId);
  const selectedPeriod = period ?? getIsoWeekPeriod().label;
  if (!isRecentExportPeriod(selectedPeriod))
    throw new GraphQLError('Export period is unavailable', { extensions: { code: 'BAD_USER_INPUT' } });
  const payload = { userId, boardType, period: selectedPeriod };
  if (!isS3Configured('private')) return unavailableStatus(payload);
  try {
    let files = await readFiles(payload);
    let runs = await readRuns(db, payload);
    if (runs[0] && NON_TERMINAL.has(runs[0].status)) {
      await reconcileBackgroundJobRun(db, runs[0].id);
      runs = await readRuns(db, payload);
    }
    // Publishing can finish between HEAD and ledger reads. A terminal ledger
    // must not stop polling while its newly published files are already ready.
    if (files.length !== expectedFormats(boardType).length && runs[0] && !NON_TERMINAL.has(runs[0].status))
      files = await readFiles(payload);
    return exportStatus(payload, files, runs);
  } catch (error) {
    logger.error('[User Data Export] Status unavailable', error);
    return unavailableStatus(payload);
  }
}

export async function requestUserDataExport(userId: string, boardType: BoardName): Promise<UserDataExportStatus> {
  await requireExportUser(userId);
  const payload = { userId, boardType, period: getIsoWeekPeriod().label };
  if (!isS3Configured('private')) return unavailableStatus(payload);
  try {
    // No object-store network request holds a user row lock.
    const files = await readFiles(payload);
    if (files.length === expectedFormats(boardType).length) {
      logger.info('[user-data-export] cached files reused', {
        boardType,
        period: payload.period,
        cacheReuse: true,
        fileBytes: files.reduce((total, file) => total + (file.fileSize ?? 0), 0),
      });
      return exportStatus(payload, files, []);
    }
    if (!enabledBatchFamiliesOrNone().has(USER_DATA_EXPORT_FAMILY)) return { ...unavailableStatus(payload), files };
    const boss = getJobQueue();
    if (!boss) return { ...unavailableStatus(payload), files };
    const requested = await db.transaction(async (transaction) => {
      const [user] = await transaction.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
      if (!user) throw new GraphQLError('Authentication required', { extensions: { code: 'UNAUTHENTICATED' } });
      let runs = await readRuns(transaction, payload);
      if (runs[0] && NON_TERMINAL.has(runs[0].status)) {
        // Reconciliation uses a savepoint on this transaction, preserving producer serialization.
        await reconcileBackgroundJobRun(transaction as unknown as DbInstance, runs[0].id);
        runs = await readRuns(transaction, payload);
      }
      const latest = runs[0];
      if (latest && NON_TERMINAL.has(latest.status)) return exportStatus(payload, files, runs);
      if (
        runs.length >= 2 ||
        (latest?.finishedAt && latest.finishedAt.getTime() + USER_DATA_EXPORT_RETRY_MS > Date.now())
      )
        return exportStatus(payload, files, runs);
      await enqueueBackgroundJobOn(transaction, boss, {
        family: USER_DATA_EXPORT_FAMILY,
        payload,
        singletonKey: userDataExportSingletonKey(payload),
      });
      return exportStatus(payload, files, await readRuns(transaction, payload));
    });
    // A worker may publish while this producer waits for the user lock. Check
    // that terminal response against fresh objects after releasing the lock.
    if (requested.status === 'failed') {
      const publishedFiles = await readFiles(payload);
      if (publishedFiles.length === expectedFormats(boardType).length) return exportStatus(payload, publishedFiles, []);
      return { ...requested, files: publishedFiles };
    }
    return requested;
  } catch (error) {
    if (error instanceof GraphQLError) throw error;
    logger.error('[User Data Export] Request unavailable', error);
    return unavailableStatus(payload);
  }
}

function isRecentExportPeriod(period: string): boolean {
  const start = exportPeriodStart(period).getTime();
  // A late-Sunday file can remain valid through the third calendar week.
  return start <= Date.now() && start + 21 * 86400_000 > Date.now();
}

async function downloadableFile(userId: string, boardType: BoardName, period: string, format: UserDataExportFormat) {
  await requireExportUser(userId);
  if (!isRecentExportPeriod(period)) return null;
  if (!expectedFormats(boardType).includes(format) || !isS3Configured('private')) return null;
  const file = (await readFiles({ userId, boardType, period })).find((candidate) => candidate.format === format);
  if (!file) return null;
  return { file, key: userDataExportKey(userId, boardType, period, format) };
}

export async function getUserDataExportDownloadLink(
  userId: string,
  boardType: BoardName,
  period: string,
  format: UserDataExportFormat,
): Promise<UserDataExportDownloadLink> {
  const download = await downloadableFile(userId, boardType, period, format);
  if (!download) throw new GraphQLError('Export is not ready or has expired', { extensions: { code: 'NOT_FOUND' } });
  const remainingSeconds = Math.floor((Date.parse(download.file.expiresAt) - Date.now()) / 1000);
  if (remainingSeconds < 1) throw new GraphQLError('Export has expired', { extensions: { code: 'NOT_FOUND' } });
  const signed = await presignGetObject('private', download.key, Math.min(300, remainingSeconds), {
    // Legacy weekly objects have no stored attachment header.
    contentDisposition: `attachment; filename="${download.file.filename}"`,
  });
  return { ...signed, filename: download.file.filename };
}

export async function getDownloadableUserDataExport(
  userId: string,
  boardType: AuroraBoardName,
  period = getIsoWeekPeriod().label,
): Promise<DownloadableUserDataExport | null> {
  const download = await downloadableFile(userId, boardType, period, 'aurora');
  if (!download) return null;
  const object = await getFromS3Strict('private', download.key);
  return object ? { key: download.key, filename: download.file.filename, ...object } : null;
}

/** Retained for existing callers and the alias-resolution regression tests. */
export async function buildUserAuroraJsonExport(userId: string, boardType: AuroraBoardName): Promise<AuroraJsonExport> {
  return buildAuroraExportFromArchive(
    await buildUserDataArchive(dbRead, userId, boardType, getIsoWeekPeriod().label),
    boardType,
  );
}

async function readStoredArchive(payload: UserDataExportJobPayload): Promise<BoardseshUserDataArchive | null> {
  const object = await getFromS3Strict(
    'private',
    userDataExportKey(payload.userId, payload.boardType, payload.period, 'boardsesh'),
  );
  if (!object) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of object.stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const archive: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (
    !archive ||
    typeof archive !== 'object' ||
    !('schemaVersion' in archive) ||
    archive.schemaVersion !== 1 ||
    !('boardType' in archive) ||
    archive.boardType !== payload.boardType ||
    !('period' in archive) ||
    archive.period !== payload.period ||
    !('user' in archive) ||
    !archive.user ||
    typeof archive.user !== 'object' ||
    !('id' in archive.user) ||
    archive.user.id !== payload.userId ||
    !('ticks' in archive) ||
    !Array.isArray(archive.ticks) ||
    !('favorites' in archive) ||
    !Array.isArray(archive.favorites) ||
    !('playlists' in archive) ||
    !Array.isArray(archive.playlists) ||
    !('climbs' in archive) ||
    !Array.isArray(archive.climbs)
  )
    throw new Error('EXPORT_ARCHIVE_INVALID');
  return archive as BoardseshUserDataArchive;
}

async function storeImmutableExport(
  context: BackgroundJobContext,
  payload: UserDataExportJobPayload,
  format: UserDataExportFormat,
  content: unknown,
  exportedAt: string,
): Promise<boolean> {
  context.signal.throwIfAborted();
  await context.transaction((transaction) => requireExportUser(payload.userId, transaction));
  context.signal.throwIfAborted();
  const buffer = Buffer.from(JSON.stringify(content, null, 2));
  try {
    await uploadToS3(
      'private',
      buffer,
      userDataExportKey(payload.userId, payload.boardType, payload.period, format),
      'application/json',
      {
        cacheControl: 'private, no-store',
        acl: null,
        ifNoneMatch: '*',
        abortSignal: context.signal,
        contentDisposition: `attachment; filename="${userDataExportFilename(payload.boardType, payload.period, format)}"`,
        metadata: { 'exported-at': exportedAt },
      },
    );
    logger.info('[user-data-export] file generated', {
      runId: context.runId,
      boardType: payload.boardType,
      period: payload.period,
      format,
      fileBytes: buffer.length,
      cacheReuse: false,
    });
    return true;
  } catch (error) {
    const status =
      error && typeof error === 'object' && '$metadata' in error
        ? (error.$metadata as { httpStatusCode?: number } | undefined)?.httpStatusCode
        : undefined;
    if (status === 412 || (error instanceof Error && error.name === 'PreconditionFailed')) return false;
    throw error;
  }
}

export async function generateUserDataExport(
  context: BackgroundJobContext,
  payload: UserDataExportJobPayload,
): Promise<void> {
  const startedAtMs = Date.now();
  await requireExportUser(payload.userId, context.database);
  let archive = await readStoredArchive(payload);
  const cacheReuse = Boolean(archive);
  if (!archive) {
    archive = await buildUserDataArchive(
      context.database,
      payload.userId,
      payload.boardType,
      payload.period,
      context.signal,
    );
    const stored = await storeImmutableExport(context, payload, 'boardsesh', archive, archive.exportedAt);
    if (!stored) archive = await readStoredArchive(payload);
    if (!archive) throw new Error('EXPORT_ARCHIVE_MISSING');
  }
  context.signal.throwIfAborted();
  if (isAuroraBoardType(payload.boardType)) {
    // A legacy file already generated this week remains untouched.
    const companion = await getS3ObjectMetadataStrict(
      'private',
      userDataExportKey(payload.userId, payload.boardType, payload.period, 'aurora'),
    );
    if (!companion)
      await storeImmutableExport(
        context,
        payload,
        'aurora',
        buildAuroraExportFromArchive(archive, payload.boardType),
        archive.exportedAt,
      );
  }
  logger.info('[user-data-export] generation completed', {
    runId: context.runId,
    boardType: payload.boardType,
    period: payload.period,
    durationMs: Date.now() - startedAtMs,
    cacheReuse,
  });
}
