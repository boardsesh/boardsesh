import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

const isS3ConfiguredMock = vi.hoisted(() => vi.fn(() => true));
const getFromS3Mock = vi.hoisted(() => vi.fn());
const validateTokenMock = vi.hoisted(() => vi.fn());
const getDownloadableUserDataExportMock = vi.hoisted(() => vi.fn());

vi.mock('../storage/s3', async () => {
  const actual = await vi.importActual<typeof import('../storage/s3')>('../storage/s3');
  return { ...actual, isS3Configured: isS3ConfiguredMock, getFromS3: getFromS3Mock };
});

vi.mock('../middleware/auth', () => ({
  validateToken: validateTokenMock,
}));

vi.mock('../services/user-data-export', () => ({
  getDownloadableUserDataExport: getDownloadableUserDataExportMock,
  getUserDataExportStatus: vi.fn(),
  requestUserDataExport: vi.fn(),
}));

const { handleStaticBetaThumbnail } = await import('../handlers/static');
const { handleUserDataExportDownload } = await import('../handlers/user-data-export');
const { logger } = await import('../utils/logger');

const THUMBNAIL_PATH = '/static/beta-link-thumbnails/instagram/ABC123.jpg';
const EXPORT_PATH = '/api/user-data-export/download?boardType=kilter';

// Declared Content-Length far larger than the bytes we actually push, so a
// truncated response is unambiguous to the client's HTTP parser.
const DECLARED_LENGTH = 4096;
const FIRST_CHUNK = Buffer.alloc(16, 0x41);

type RequestOutcome = {
  response: Response;
  serverResponse: ServerResponse;
};

/**
 * A body that delivers one chunk and then dies the way an R2 read does when the
 * backend→R2 TLS connection closes early: `destroy(new Error('aborted'))` on the
 * source, which `readable.pipe(dest)` does not listen for.
 */
function abortingSource(): Readable {
  let started = false;
  const stream = new Readable({
    read() {
      if (started) return;
      started = true;
      this.push(FIRST_CHUNK);
      setTimeout(() => this.destroy(new Error('aborted')), 25);
    },
  });
  return stream;
}

/** A body that delivers one chunk and then stalls, so the client can abort first. */
function stallingSource(): Readable {
  let started = false;
  return new Readable({
    read() {
      if (started) return;
      started = true;
      this.push(FIRST_CHUNK);
    },
  });
}

function s3Object(stream: Readable) {
  return { stream, contentType: 'image/jpeg', contentLength: DECLARED_LENGTH };
}

async function startServer(handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
  let lastResponse: ServerResponse | undefined;
  const server = createServer((req, res) => {
    lastResponse = res;
    void handle(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    server,
    getLastResponse: () => lastResponse,
  };
}

function closeServer(server: Server): Promise<void> {
  // closeAllConnections first: an unguarded pipe leaves the response open
  // forever, and `close()` alone would wait on it and hang the suite.
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Client-side deadline. Well past the ~25ms the fixed handler needs to tear a
 * failed body down, and short enough that an unguarded pipe (which leaves the
 * response hanging below its Content-Length) fails fast instead of stalling.
 */
const CLIENT_DEADLINE_MS = 2000;

/**
 * Run `body` with `process.on('uncaughtException')` swapped for a recorder, so a
 * stream error thrown out of a `nextTick` is captured instead of taking down the
 * worker. Node's own listeners are restored with `rawListeners`, which preserves
 * `once` wrappers.
 */
async function recordUncaughtExceptions(body: () => Promise<void>): Promise<Error[]> {
  const recorded: Error[] = [];
  const original = process.rawListeners('uncaughtException') as NodeJS.UncaughtExceptionListener[];
  process.removeAllListeners('uncaughtException');
  process.on('uncaughtException', (error) => {
    recorded.push(error);
  });

  try {
    await body();
    // Let a queued `emitErrorNT` land before we hand the process back.
    await delay(100);
  } finally {
    process.removeAllListeners('uncaughtException');
    for (const listener of original) process.on('uncaughtException', listener);
  }

  return recorded;
}

let infoSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  isS3ConfiguredMock.mockReturnValue(true);
  infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger);
  warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('media streaming: an S3 body that fails mid-response', () => {
  it('does not reach process.on(uncaughtException) when the R2 read aborts', async () => {
    getFromS3Mock.mockResolvedValue(s3Object(abortingSource()));

    const { baseUrl, server, getLastResponse } = await startServer((req, res) =>
      handleStaticBetaThumbnail(req, res, 'instagram', 'ABC123.jpg'),
    );

    let outcome: RequestOutcome | undefined;
    try {
      const recorded = await recordUncaughtExceptions(async () => {
        const response = await fetch(`${baseUrl}${THUMBNAIL_PATH}`, {
          signal: AbortSignal.timeout(CLIENT_DEADLINE_MS),
        });
        expect(response.status).toBe(200);
        // The body is cut below its Content-Length, so the read fails.
        await expect(response.arrayBuffer()).rejects.toThrow();
        outcome = { response, serverResponse: getLastResponse() as ServerResponse };
      });

      expect(recorded.map((error) => error.message)).toEqual([]);
    } finally {
      await closeServer(server);
    }

    const serverResponse = outcome?.serverResponse;
    expect(serverResponse).toBeDefined();
    // Destroyed, never `end()`ed: a truncated body must not look complete.
    expect(serverResponse?.destroyed).toBe(true);
    expect(serverResponse?.writableEnded).toBe(false);
  });

  it('logs the failed read with its route and object key', async () => {
    getFromS3Mock.mockResolvedValue(s3Object(abortingSource()));

    const { baseUrl, server } = await startServer((req, res) =>
      handleStaticBetaThumbnail(req, res, 'instagram', 'ABC123.jpg'),
    );

    try {
      await recordUncaughtExceptions(async () => {
        const response = await fetch(`${baseUrl}${THUMBNAIL_PATH}`, {
          signal: AbortSignal.timeout(CLIENT_DEADLINE_MS),
        });
        await expect(response.arrayBuffer()).rejects.toThrow();
      });
    } finally {
      await closeServer(server);
    }

    // `aborted` is whitelisted in isClientAbortError, so this classifies as an
    // abort and logs at info — the point is that it is logged, with the key,
    // instead of killing the replica.
    const logged = [...infoSpy.mock.calls, ...warnSpy.mock.calls];
    expect(logged.length).toBeGreaterThan(0);
    const streamLog = logged.find((call) => String(call[0]).startsWith('Stream to client'));
    expect(streamLog).toBeDefined();
    expect(streamLog?.[1]).toMatchObject({
      route: THUMBNAIL_PATH,
      source: 'beta-link-thumbnails/instagram/ABC123.jpg',
    });
  });

  it('guards the user-data-export download too', async () => {
    validateTokenMock.mockResolvedValue({ userId: 'user-123' });
    getDownloadableUserDataExportMock.mockResolvedValue({
      key: 'user-data-exports/user-123/kilter.json',
      filename: 'kilter-export.json',
      stream: abortingSource(),
      contentType: 'application/json',
      contentLength: DECLARED_LENGTH,
    });

    const { baseUrl, server, getLastResponse } = await startServer((req, res) =>
      handleUserDataExportDownload(req, res, new URL(EXPORT_PATH, 'http://127.0.0.1')),
    );

    try {
      const recorded = await recordUncaughtExceptions(async () => {
        const response = await fetch(`${baseUrl}${EXPORT_PATH}`, {
          headers: { Authorization: 'Bearer export-token' },
          signal: AbortSignal.timeout(CLIENT_DEADLINE_MS),
        });
        expect(response.status).toBe(200);
        await expect(response.arrayBuffer()).rejects.toThrow();
      });

      expect(recorded.map((error) => error.message)).toEqual([]);
      expect(getLastResponse()?.destroyed).toBe(true);
    } finally {
      await closeServer(server);
    }
  });
});

describe('media streaming: a client that walks away mid-download', () => {
  it('destroys the S3 source and logs at info, not warn', async () => {
    const source = stallingSource();
    getFromS3Mock.mockResolvedValue(s3Object(source));

    const { baseUrl, server } = await startServer((req, res) =>
      handleStaticBetaThumbnail(req, res, 'instagram', 'ABC123.jpg'),
    );

    try {
      const abortController = new AbortController();
      const response = await fetch(`${baseUrl}${THUMBNAIL_PATH}`, { signal: abortController.signal });
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      await reader?.read();
      abortController.abort();
      await reader?.cancel().catch(() => {});

      // Give the server's end-of-stream detection a tick to fire.
      for (let attempt = 0; attempt < 50 && !source.destroyed; attempt += 1) {
        await delay(10);
      }
    } finally {
      await closeServer(server);
    }

    // Without pipeline this upstream socket would keep draining into a dead
    // response; with it, the client's disconnect tears the S3 read down.
    expect(source.destroyed).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      'Stream to client aborted',
      expect.objectContaining({ route: THUMBNAIL_PATH }),
    );
  });
});
