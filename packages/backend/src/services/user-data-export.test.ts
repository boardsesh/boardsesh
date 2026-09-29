import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { DbInstance } from '@boardsesh/db/client';
import type { backgroundJobRuns } from '@boardsesh/db/schema';
import { BackgroundJobError, type BackgroundJobContext } from '../workers/families/types';
import { MAX_USER_DATA_EXPORT_BYTES, type BoardseshUserDataArchive } from './user-data-export-archive';

type Run = typeof backgroundJobRuns.$inferSelect;
const fixtures = vi.hoisted(() => ({ live: true, enabled: true, queue: true, runs: [] as Run[] }));
const databaseMocks = vi.hoisted(() => {
  const select = vi.fn((projection?: unknown) => {
    const rows = () => (projection ? (fixtures.live ? [{ id: 'user-1' }] : []) : fixtures.runs);
    const query = {
      from: () => query,
      where: () => query,
      orderBy: () => query,
      limit: async () => rows(),
      for: async () => rows(),
    };
    return query;
  });
  const database = {
    select,
    transaction: vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) => callback(database)),
  };
  return database;
});
const storageMocks = vi.hoisted(() => ({
  getFromS3Strict: vi.fn(),
  getS3ObjectMetadataStrict: vi.fn(),
  isS3Configured: vi.fn(),
  uploadToS3: vi.fn(),
  presignGetObject: vi.fn(),
}));
const archiveMocks = vi.hoisted(() => ({ buildUserDataArchive: vi.fn() }));
const jobMocks = vi.hoisted(() => ({ enqueueBackgroundJobOn: vi.fn(), reconcileBackgroundJobRun: vi.fn() }));
const storedObjects = new Map<string, Buffer>();
vi.mock('../storage/s3', () => storageMocks);
vi.mock('../db/client', () => ({ db: databaseMocks, dbRead: databaseMocks }));
vi.mock('./job-queue', () => ({ getJobQueue: () => (fixtures.queue ? {} : null) }));
vi.mock('./batch-schedules', () => ({
  enabledBatchFamiliesOrNone: () => new Set(fixtures.enabled ? ['user-data-export'] : []),
}));
vi.mock('../workers/jobs', () => ({ enqueueBackgroundJobOn: jobMocks.enqueueBackgroundJobOn }));
vi.mock('@boardsesh/db/queries', () => ({ reconcileBackgroundJobRun: jobMocks.reconcileBackgroundJobRun }));
vi.mock('./user-data-export-archive', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./user-data-export-archive')>()),
  buildUserDataArchive: archiveMocks.buildUserDataArchive,
}));
const service = await import('./user-data-export');
const { userDataExportFamily } = await import('../workers/families/user-data-export');
const { logger } = await import('../utils/logger');
const NOW = new Date('2026-09-29T12:00:00Z');
const payload = { userId: 'user-1', boardType: 'kilter' as const, period: '2026-W40' };
const archive: BoardseshUserDataArchive = {
  schemaVersion: 1,
  ...payload,
  exportedAt: NOW.toISOString(),
  user: { id: 'user-1', name: 'Climber', email: null, createdAt: NOW.toISOString() },
  ticks: [],
  favorites: [],
  playlists: [],
  climbs: [],
};
const metadata = { lastModified: NOW, contentLength: 123, metadata: { 'exported-at': NOW.toISOString() } };
const context: BackgroundJobContext = {
  runId: '11111111-1111-4111-8111-111111111111',
  family: 'user-data-export',
  database: databaseMocks as unknown as DbInstance,
  signal: new AbortController().signal,
  expiresAt: NOW.getTime() + 300000,
  transaction: async (callback) => callback(databaseMocks as unknown as Parameters<typeof callback>[0]),
  enqueue: async () => {
    throw new Error('Unexpected enqueue');
  },
};
const run = (status: Run['status'], id = context.runId): Run => ({
  id,
  family: 'user-data-export',
  queue: 'background-maintenance-delivery',
  role: 'maintenance-delivery',
  payload,
  singletonKey: service.userDataExportSingletonKey(payload),
  status,
  attemptNumber: -1,
  attemptToken: null,
  createdAt: NOW,
  startedAt: null,
  heartbeatAt: null,
  finishedAt: status === 'failed' ? NOW : null,
  deadlineAt: new Date(NOW.getTime() + 1800000),
  errorCode: null,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  fixtures.live = true;
  fixtures.enabled = true;
  fixtures.queue = true;
  fixtures.runs = [];
  storedObjects.clear();
  storageMocks.isS3Configured.mockReturnValue(true);
  storageMocks.getS3ObjectMetadataStrict.mockResolvedValue(null);
  storageMocks.getFromS3Strict.mockImplementation(async (_bucket: string, key: string) => {
    const buffer = storedObjects.get(key);
    return buffer ? { stream: Readable.from([buffer]) } : null;
  });
  storageMocks.uploadToS3.mockImplementation(async (_bucket: string, buffer: Buffer, key: string) => {
    storedObjects.set(key, buffer);
    return { key };
  });
  storageMocks.presignGetObject.mockResolvedValue({
    url: 'https://storage.test/signed',
    expiresAt: new Date(NOW.getTime() + 300000).toISOString(),
  });
  archiveMocks.buildUserDataArchive.mockResolvedValue(archive);
  jobMocks.reconcileBackgroundJobRun.mockResolvedValue(false);
  jobMocks.enqueueBackgroundJobOn.mockImplementation(async () => {
    fixtures.runs = [run('queued')];
    return { runId: context.runId, alreadyQueued: false };
  });
  vi.spyOn(logger, 'error').mockImplementation(() => logger);
  vi.spyOn(logger, 'info').mockImplementation(() => logger);
  vi.spyOn(logger, 'warn').mockImplementation(() => logger);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('weekly user exports', () => {
  it('returns a generic unavailable status without querying storage when unconfigured', async () => {
    storageMocks.isS3Configured.mockReturnValue(false);
    expect(await service.getUserDataExportStatus('user-1', 'kilter')).toMatchObject({
      status: 'unavailable',
      files: [],
      error: 'Export service is temporarily unavailable.',
    });
    expect(storageMocks.getS3ObjectMetadataStrict).not.toHaveBeenCalled();
  });
  it('rejects a deleted account even if storage is disabled', async () => {
    fixtures.live = false;
    storageMocks.isS3Configured.mockReturnValue(false);
    await expect(service.getUserDataExportStatus('user-1', 'kilter')).rejects.toMatchObject({
      extensions: { code: 'UNAUTHENTICATED' },
    });
    await expect(service.requestUserDataExport('user-1', 'kilter')).rejects.toMatchObject({
      extensions: { code: 'UNAUTHENTICATED' },
    });
    await expect(service.getDownloadableUserDataExport('user-1', 'kilter')).rejects.toMatchObject({
      extensions: { code: 'UNAUTHENTICATED' },
    });
  });
  it('does not generate after a storage outage or expose the upstream error', async () => {
    storageMocks.getS3ObjectMetadataStrict.mockRejectedValue(new Error('private credentials failed'));
    expect(await service.requestUserDataExport('user-1', 'kilter')).toMatchObject({
      status: 'unavailable',
      error: 'Export service is temporarily unavailable.',
    });
    expect(jobMocks.enqueueBackgroundJobOn).not.toHaveBeenCalled();
    expect(archiveMocks.buildUserDataArchive).not.toHaveBeenCalled();
  });
  it('reuses both completed files while producers are disabled', async () => {
    fixtures.enabled = false;
    storageMocks.getS3ObjectMetadataStrict.mockResolvedValue(metadata);
    const status = await service.requestUserDataExport('user-1', 'kilter');
    expect(status.status).toBe('ready');
    expect(status.files.map((file) => file.format)).toEqual(['boardsesh', 'aurora']);
    expect(status.refreshAt).toBe('2026-10-05T00:00:00.000Z');
    expect(jobMocks.enqueueBackgroundJobOn).not.toHaveBeenCalled();
    expect(storageMocks.getFromS3Strict).not.toHaveBeenCalled();
  });
  it('reports completion from the full archive when a preserved companion has an older date', async () => {
    const legacyExportedAt = new Date(NOW.getTime() - 86400000).toISOString();
    storageMocks.getS3ObjectMetadataStrict.mockImplementation(async (_bucket, key: string) =>
      key.endsWith('.boardsesh.json') ? metadata : { ...metadata, metadata: { 'exported-at': legacyExportedAt } },
    );
    const status = await service.getUserDataExportStatus('user-1', 'kilter');
    expect(status.completedAt).toBe(archive.exportedAt);
    expect(status.files.find((file) => file.format === 'aurora')?.exportedAt).toBe(legacyExportedAt);
  });
  it.each(['status', 'request'] as const)(
    'observes files published between initial HEAD and terminal ledger during %s',
    async (operation) => {
      fixtures.runs = [{ ...run('succeeded'), finishedAt: NOW }];
      storageMocks.getS3ObjectMetadataStrict
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValue(metadata);
      const status =
        operation === 'status'
          ? await service.getUserDataExportStatus('user-1', 'kilter')
          : await service.requestUserDataExport('user-1', 'kilter');
      expect(status).toMatchObject({ status: 'ready', period: payload.period });
      expect(status.files).toHaveLength(2);
      expect(jobMocks.enqueueBackgroundJobOn).not.toHaveBeenCalled();
    },
  );
  it('keeps polling a captured snapshot after UTC week rollover', async () => {
    fixtures.runs = [run('running')];
    vi.setSystemTime(new Date('2026-10-05T00:00:01Z'));
    const status = await service.getUserDataExportStatus('user-1', 'kilter', payload.period);
    expect(status).toMatchObject({ status: 'generating', period: '2026-W40' });
    expect(storageMocks.getS3ObjectMetadataStrict.mock.calls.every((call) => call[1].includes('2026-W40'))).toBe(true);
    expect((await service.getUserDataExportStatus('user-1', 'kilter')).period).toBe('2026-W41');
  });
  it('rejects invalid, future and old status periods before reading objects', async () => {
    for (const period of ['2026-W54', '2026-W41', '2026-W36']) {
      await expect(service.getUserDataExportStatus('user-1', 'kilter', period)).rejects.toMatchObject({
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
    expect(storageMocks.getS3ObjectMetadataStrict).not.toHaveBeenCalled();
  });
  it.each(['queued', 'running', 'retrying'] as const)('coalesces onto an existing %s run', async (state) => {
    fixtures.runs = [run(state)];
    expect(await service.requestUserDataExport('user-1', 'kilter')).toMatchObject({ status: 'generating' });
    expect(jobMocks.enqueueBackgroundJobOn).not.toHaveBeenCalled();
  });
  it('enqueues once with a captured board, owner and period', async () => {
    expect(await service.requestUserDataExport('user-1', 'kilter')).toMatchObject({
      status: 'generating',
      period: '2026-W40',
    });
    expect(jobMocks.enqueueBackgroundJobOn).toHaveBeenCalledWith(
      databaseMocks,
      {},
      { family: 'user-data-export', payload, singletonKey: 'user-1:kilter:2026-W40' },
    );
  });
  it('declines requests when the worker producer gate or queue is unavailable', async () => {
    fixtures.enabled = false;
    expect((await service.requestUserDataExport('user-1', 'kilter')).status).toBe('unavailable');
    fixtures.enabled = true;
    fixtures.queue = false;
    expect((await service.requestUserDataExport('user-1', 'kilter')).status).toBe('unavailable');
    expect(jobMocks.enqueueBackgroundJobOn).not.toHaveBeenCalled();
  });
  it('requires five minutes before a manual retry and permits at most two runs weekly', async () => {
    fixtures.runs = [run('failed')];
    expect(await service.requestUserDataExport('user-1', 'kilter')).toMatchObject({
      status: 'failed',
      retryAt: '2026-09-29T12:05:00.000Z',
    });
    expect(jobMocks.enqueueBackgroundJobOn).not.toHaveBeenCalled();
    fixtures.runs = [run('failed'), run('failed', '22222222-2222-4222-8222-222222222222')];
    vi.setSystemTime(new Date(NOW.getTime() + 600000));
    expect(await service.requestUserDataExport('user-1', 'kilter')).toMatchObject({
      status: 'failed',
      retryAt: '2026-10-05T00:00:00.000Z',
    });
    expect(jobMocks.enqueueBackgroundJobOn).not.toHaveBeenCalled();
  });
  it('builds only a missing companion from the immutable archive without database rereads', async () => {
    storageMocks.getFromS3Strict.mockResolvedValue({ stream: Readable.from([Buffer.from(JSON.stringify(archive))]) });
    await service.generateUserDataExport(context, payload);
    expect(archiveMocks.buildUserDataArchive).not.toHaveBeenCalled();
    expect(storageMocks.uploadToS3).toHaveBeenCalledOnce();
    expect(storageMocks.uploadToS3.mock.calls[0]).toMatchObject([
      'private',
      expect.any(Buffer),
      'user-data-exports/user-1/kilter/2026-W40.json',
      'application/json',
      {
        ifNoneMatch: '*',
        contentDisposition: 'attachment; filename="boardsesh-kilter-export-2026-W40.json"',
        acl: null,
      },
    ]);
  });
  it('stops retries for malformed cached JSON without leaking personal bytes', async () => {
    const personalBytes = 'sensitive cached personal note';
    storageMocks.getFromS3Strict.mockResolvedValue({
      stream: Readable.from([Buffer.from(`{"note":"${personalBytes}"`)]),
    });
    await expect(userDataExportFamily.execute(context, payload)).rejects.toMatchObject({
      name: 'BackgroundJobError',
      code: 'EXPORT_ARCHIVE_INVALID',
      message: 'EXPORT_ARCHIVE_INVALID',
      retryable: false,
    });
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(personalBytes);
    expect(archiveMocks.buildUserDataArchive).not.toHaveBeenCalled();
    expect(storageMocks.uploadToS3).not.toHaveBeenCalled();
  });
  it('rejects an oversized serialized archive before any upload', async () => {
    archiveMocks.buildUserDataArchive.mockResolvedValue({
      ...archive,
      user: { ...archive.user, name: 'x'.repeat(MAX_USER_DATA_EXPORT_BYTES) },
    });
    await expect(userDataExportFamily.execute(context, payload)).rejects.toMatchObject({
      code: 'EXPORT_TOO_LARGE',
      retryable: false,
    });
    expect(storageMocks.uploadToS3).not.toHaveBeenCalled();
  });
  it('rejects a cached archive with an oversized Content-Length before reading it', async () => {
    const stream = Readable.from([]);
    storageMocks.getFromS3Strict.mockResolvedValue({ stream, contentLength: MAX_USER_DATA_EXPORT_BYTES + 1 });
    await expect(userDataExportFamily.execute(context, payload)).rejects.toMatchObject({
      code: 'EXPORT_TOO_LARGE',
      retryable: false,
    });
    expect(stream.destroyed).toBe(true);
    expect(storageMocks.uploadToS3).not.toHaveBeenCalled();
  });
  it('rejects cached bytes beyond the cap even when Content-Length is too small', async () => {
    const chunk = Buffer.alloc(1024 * 1024, 32);
    const stream = Readable.from(
      (function* () {
        for (let index = 0; index < 33; index += 1) yield chunk;
      })(),
    );
    storageMocks.getFromS3Strict.mockResolvedValue({ stream, contentLength: 1 });
    await expect(userDataExportFamily.execute(context, payload)).rejects.toMatchObject({
      code: 'EXPORT_TOO_LARGE',
      retryable: false,
    });
    expect(stream.destroyed).toBe(true);
    expect(storageMocks.uploadToS3).not.toHaveBeenCalled();
  });
  it.each([
    ['schema version', { ...archive, schemaVersion: 2 }],
    ['owner', { ...archive, user: { ...archive.user, id: 'other-user' } }],
    ['board', { ...archive, boardType: 'tension' }],
    ['period', { ...archive, period: '2026-W39' }],
    ['collection shape', { ...archive, ticks: null }],
  ])('stops retries for an immutable archive with an invalid %s', async (_field, invalidArchive) => {
    storageMocks.getFromS3Strict.mockResolvedValue({
      stream: Readable.from([Buffer.from(JSON.stringify(invalidArchive))]),
    });
    await expect(userDataExportFamily.execute(context, payload)).rejects.toMatchObject({
      code: 'EXPORT_ARCHIVE_INVALID',
      retryable: false,
    });
    expect(archiveMocks.buildUserDataArchive).not.toHaveBeenCalled();
    expect(storageMocks.uploadToS3).not.toHaveBeenCalled();
  });
  it.each(['request', 'body'] as const)(
    'preserves retryable transient archive-read failures during the %s',
    async (stage) => {
      const failure = Object.assign(new Error('Transient storage outage'), { $metadata: { httpStatusCode: 503 } });
      if (stage === 'request') storageMocks.getFromS3Strict.mockRejectedValue(failure);
      else
        storageMocks.getFromS3Strict.mockResolvedValue({
          stream: Readable.from(
            (async function* () {
              yield Buffer.from('{"partial":');
              throw failure;
            })(),
          ),
        });
      await expect(userDataExportFamily.execute(context, payload)).rejects.toBe(failure);
      expect(archiveMocks.buildUserDataArchive).not.toHaveBeenCalled();
      expect(storageMocks.uploadToS3).not.toHaveBeenCalled();
    },
  );
  it('returns no legacy Aurora stream for a non-Aurora board', async () => {
    await expect(service.getDownloadableUserDataExport('user-1', 'spray')).resolves.toBeNull();
    expect(storageMocks.getS3ObjectMetadataStrict).not.toHaveBeenCalled();
    expect(storageMocks.getFromS3Strict).not.toHaveBeenCalled();
  });
  it('preserves a legacy companion while adding the full archive', async () => {
    storageMocks.getS3ObjectMetadataStrict.mockResolvedValue(metadata);
    await service.generateUserDataExport(context, payload);
    expect(archiveMocks.buildUserDataArchive).toHaveBeenCalledOnce();
    expect(storageMocks.uploadToS3).toHaveBeenCalledOnce();
    expect(storageMocks.uploadToS3.mock.calls[0][2]).toBe('user-data-exports/user-1/kilter/2026-W40.boardsesh.json');
  });
  it('reloads the winning archive after a conditional write collision', async () => {
    const winningArchive = { ...archive, user: { ...archive.user, name: 'Immutable winner' } };
    storageMocks.getFromS3Strict
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ stream: Readable.from([Buffer.from(JSON.stringify(winningArchive))]) });
    storageMocks.uploadToS3
      .mockRejectedValueOnce(Object.assign(new Error('Exists'), { $metadata: { httpStatusCode: 412 } }))
      .mockResolvedValueOnce({ key: 'companion' });
    await service.generateUserDataExport(context, payload);
    const companion = JSON.parse(storageMocks.uploadToS3.mock.calls[1][1].toString()) as { user: { username: string } };
    expect(companion.user.username).toBe('Immutable winner');
  });
  it('retries when a winning archive is not readable yet and reuses it on the next execution', async () => {
    const winningArchive = { ...archive, user: { ...archive.user, name: 'Delayed immutable winner' } };
    storageMocks.getFromS3Strict
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ stream: Readable.from([Buffer.from(JSON.stringify(winningArchive))]) });
    storageMocks.uploadToS3.mockRejectedValueOnce(
      Object.assign(new Error('Exists'), { $metadata: { httpStatusCode: 412 } }),
    );
    const failure = await userDataExportFamily.execute(context, payload).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(BackgroundJobError);
    expect(failure).toMatchObject({ message: 'EXPORT_ARCHIVE_MISSING' });
    expect(archiveMocks.buildUserDataArchive).toHaveBeenCalledOnce();
    expect(storageMocks.uploadToS3).toHaveBeenCalledOnce();

    await expect(userDataExportFamily.execute(context, payload)).resolves.toBeUndefined();
    expect(archiveMocks.buildUserDataArchive).toHaveBeenCalledOnce();
    expect(storageMocks.uploadToS3).toHaveBeenCalledTimes(2);
    const companion = JSON.parse(storageMocks.uploadToS3.mock.calls[1][1].toString()) as { user: { username: string } };
    expect(companion.user.username).toBe('Delayed immutable winner');
  });
  it('creates only the archive for a non-Aurora board', async () => {
    archiveMocks.buildUserDataArchive.mockResolvedValue({ ...archive, boardType: 'spray' });
    await service.generateUserDataExport(context, { ...payload, boardType: 'spray' });
    expect(storageMocks.uploadToS3).toHaveBeenCalledOnce();
    expect(storageMocks.getFromS3Strict).toHaveBeenCalledTimes(2);
    fixtures.runs = [run('succeeded')];
    storageMocks.getS3ObjectMetadataStrict.mockResolvedValue(metadata);
    expect((await service.getUserDataExportStatus('user-1', 'spray')).status).toBe('ready');
    expect(storageMocks.getFromS3Strict).toHaveBeenCalledTimes(2);
  });
  it.each(['moonboard', 'spray'] as const)(
    'does not advertise a corrupt newly stored %s archive or sign it',
    async (boardType) => {
      const boardPayload = { ...payload, boardType };
      archiveMocks.buildUserDataArchive.mockResolvedValue({ ...archive, boardType });
      storageMocks.uploadToS3.mockImplementation(async (_bucket: string, _buffer: Buffer, key: string) => {
        storedObjects.set(key, Buffer.from('{"schemaVersion":1,"user":"corrupt"}'));
        return { key };
      });
      await expect(userDataExportFamily.execute(context, boardPayload)).rejects.toMatchObject({
        code: 'EXPORT_ARCHIVE_INVALID',
        retryable: false,
      });
      expect(storageMocks.uploadToS3).toHaveBeenCalledOnce();
      expect(storageMocks.getFromS3Strict).toHaveBeenCalledTimes(2);

      fixtures.runs = [{ ...run('failed'), errorCode: 'EXPORT_ARCHIVE_INVALID' }];
      storageMocks.getS3ObjectMetadataStrict.mockResolvedValue(metadata);
      const status = await service.getUserDataExportStatus('user-1', boardType);
      expect(status).toMatchObject({
        status: 'failed',
        files: [],
        retryAt: '2026-10-05T00:00:00.000Z',
        errorCode: 'EXPORT_ARCHIVE_INVALID',
      });
      expect((await service.requestUserDataExport('user-1', boardType)).status).toBe('failed');
      expect(jobMocks.enqueueBackgroundJobOn).not.toHaveBeenCalled();
      await expect(
        service.getUserDataExportDownloadLink('user-1', boardType, payload.period, 'boardsesh'),
      ).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
      expect(storageMocks.presignGetObject).not.toHaveBeenCalled();
      // Status, request, and link checks use metadata and ledger only.
      expect(storageMocks.getFromS3Strict).toHaveBeenCalledTimes(2);
    },
  );
  it('keeps an independent Aurora companion available when the Boardsesh archive is invalid', async () => {
    fixtures.runs = [{ ...run('failed'), errorCode: 'EXPORT_ARCHIVE_INVALID' }];
    storageMocks.getS3ObjectMetadataStrict.mockResolvedValue(metadata);
    const status = await service.getUserDataExportStatus('user-1', 'kilter');
    expect(status.status).toBe('failed');
    expect(status.files.map((file) => file.format)).toEqual(['aurora']);
    expect(status.completedAt).toBeUndefined();
    await expect(
      service.getUserDataExportDownloadLink('user-1', 'kilter', payload.period, 'boardsesh'),
    ).rejects.toMatchObject({
      extensions: { code: 'NOT_FOUND' },
    });
    await expect(
      service.getUserDataExportDownloadLink('user-1', 'kilter', payload.period, 'aurora'),
    ).resolves.toMatchObject({
      filename: 'boardsesh-kilter-export-2026-W40.json',
    });
    expect(storageMocks.presignGetObject).toHaveBeenCalledOnce();
    expect(jobMocks.enqueueBackgroundJobOn).not.toHaveBeenCalled();
  });
  it('validates a partial archive only when a climber taps download during generation', async () => {
    fixtures.runs = [run('running')];
    storageMocks.getS3ObjectMetadataStrict.mockImplementation(async (_bucket, key: string) =>
      key.endsWith('.boardsesh.json') ? metadata : null,
    );
    const status = await service.getUserDataExportStatus('user-1', 'kilter');
    expect(status.status).toBe('generating');
    expect(status.files.map((file) => file.format)).toEqual(['boardsesh']);
    expect(storageMocks.getFromS3Strict).not.toHaveBeenCalled();

    storedObjects.set(
      service.userDataExportKey(payload.userId, payload.boardType, payload.period, 'boardsesh'),
      Buffer.from('not json'),
    );
    await expect(
      service.getUserDataExportDownloadLink('user-1', 'kilter', payload.period, 'boardsesh'),
    ).rejects.toMatchObject({
      extensions: { code: 'NOT_FOUND' },
    });
    expect(storageMocks.presignGetObject).not.toHaveBeenCalled();

    storedObjects.set(
      service.userDataExportKey(payload.userId, payload.boardType, payload.period, 'boardsesh'),
      Buffer.from(JSON.stringify(archive)),
    );
    await expect(
      service.getUserDataExportDownloadLink('user-1', 'kilter', payload.period, 'boardsesh'),
    ).resolves.toMatchObject({
      filename: 'boardsesh-kilter-archive-2026-W40.json',
    });
    expect(storageMocks.getFromS3Strict).toHaveBeenCalledTimes(2);
  });
  it('reports a size-limit failure without hiding a valid partial Boardsesh archive', async () => {
    fixtures.runs = [{ ...run('failed'), errorCode: 'EXPORT_TOO_LARGE' }];
    storageMocks.getS3ObjectMetadataStrict.mockImplementation(async (_bucket, key: string) =>
      key.endsWith('.boardsesh.json') ? metadata : null,
    );
    fixtures.enabled = false;
    const status = await service.getUserDataExportStatus('user-1', 'kilter');
    expect(status).toMatchObject({
      status: 'failed',
      errorCode: 'EXPORT_TOO_LARGE',
      retryAt: '2026-10-05T00:00:00.000Z',
    });
    expect(status.error).toContain('too large');
    expect(status.files.map((file) => file.format)).toEqual(['boardsesh']);
    expect((await service.requestUserDataExport('user-1', 'kilter')).status).toBe('failed');
    await expect(
      service.getUserDataExportDownloadLink('user-1', 'kilter', payload.period, 'boardsesh'),
    ).resolves.toMatchObject({
      filename: 'boardsesh-kilter-archive-2026-W40.json',
    });
    expect(storageMocks.getFromS3Strict).not.toHaveBeenCalled();
    expect(jobMocks.enqueueBackgroundJobOn).not.toHaveBeenCalled();
  });
  it('signs an attachment for legacy files without stored disposition and keeps the requested week', async () => {
    storageMocks.getS3ObjectMetadataStrict.mockImplementation(async (_bucket, key: string) =>
      key.endsWith('.boardsesh.json') ? null : metadata,
    );
    const download = await service.getUserDataExportDownloadLink('user-1', 'kilter', '2026-W39', 'aurora');
    expect(download.filename).toBe('boardsesh-kilter-export-2026-W39.json');
    expect(storageMocks.presignGetObject).toHaveBeenCalledWith(
      'private',
      'user-data-exports/user-1/kilter/2026-W39.json',
      300,
      {
        contentDisposition: 'attachment; filename="boardsesh-kilter-export-2026-W39.json"',
      },
    );
  });
  it('rejects expired copies, future weeks, invalid ISO weeks and unsupported companions', async () => {
    storageMocks.getS3ObjectMetadataStrict.mockResolvedValue({
      ...metadata,
      metadata: { 'exported-at': new Date(NOW.getTime() - 14 * 86400000).toISOString() },
    });
    await expect(
      service.getUserDataExportDownloadLink('user-1', 'kilter', '2026-W39', 'boardsesh'),
    ).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    await expect(
      service.getUserDataExportDownloadLink('user-1', 'kilter', '2026-W41', 'boardsesh'),
    ).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    await expect(
      service.getUserDataExportDownloadLink('user-1', 'kilter', '2026-W54', 'boardsesh'),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    await expect(
      service.getUserDataExportDownloadLink('user-1', 'moonboard', '2026-W40', 'aurora'),
    ).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
  });
  it('does not issue a fresh URL during the last incomplete second of retention', async () => {
    storageMocks.getS3ObjectMetadataStrict.mockResolvedValue({
      ...metadata,
      metadata: {
        'exported-at': new Date(NOW.getTime() - service.USER_DATA_EXPORT_RETENTION_MS + 900).toISOString(),
      },
    });
    await expect(
      service.getUserDataExportDownloadLink('user-1', 'kilter', '2026-W39', 'boardsesh'),
    ).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    expect(storageMocks.presignGetObject).not.toHaveBeenCalled();
  });
});
