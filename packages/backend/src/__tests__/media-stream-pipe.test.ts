import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { recordUncaughtExceptions } from './helpers/uncaught-exceptions';

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

const { handleStaticAvatar, handleStaticBetaThumbnail } = await import('../handlers/static');
const { handleUserDataExportDownload } = await import('../handlers/user-data-export');
const { logger } = await import('../utils/logger');

const THUMBNAIL_PATH = '/static/beta-link-thumbnails/instagram/ABC123.jpg';
const EXPORT_PATH = '/api/user-data-export/download?boardType=kilter';
const AVATAR_FILE = '11111111-1111-4111-8111-111111111111.jpg';
const SIZED_AVATAR_PATH = `/static/avatars/${AVATAR_FILE}?size=128`;

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

let infoSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  isS3ConfiguredMock.mockReturnValue(true);
  // Three separate spies on purpose. `SentryWinstonTransport` is constructed at
  // `level: 'error'`, so the level IS the alerting behaviour — merging these and
  // asserting only that *something* logged is what let #5343's regression
  // through (#5359).
  infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger);
  warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
  errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
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

  it('logs the failed read at error, with its route, object key and the error', async () => {
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

    // `error`, not `warn` or `info`: SentryWinstonTransport only takes `error`,
    // so anything quieter means the next R2 degradation is invisible — which is
    // exactly what #5343 shipped. The error object rides along for the stack.
    expect(errorSpy).toHaveBeenCalledWith(
      'Upstream read failed',
      expect.objectContaining({
        route: THUMBNAIL_PATH,
        source: 'beta-link-thumbnails/instagram/ABC123.jpg',
      }),
      expect.any(Error),
    );
    // And it is not ALSO filed as a routine client abort.
    expect(infoSpy).not.toHaveBeenCalledWith('Stream to client aborted', expect.anything());
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('answers a sized request whose buffered read dies, instead of hanging', async () => {
    // `?size=` on a mutable key (`cacheVariant: false`) buffers the original
    // rather than piping it — the one S3 body not routed through
    // `pipeStreamToResponse`. Unguarded, the rejection unwound past the router,
    // which read `aborted` as a client abort and returned without writing, so
    // the connection sat open until the client gave up (#5359).
    getFromS3Mock.mockResolvedValue(s3Object(abortingSource()));

    const { baseUrl, server } = await startServer((req, res) => handleStaticAvatar(req, res, AVATAR_FILE, 128));

    try {
      const recorded = await recordUncaughtExceptions(async () => {
        // The deadline is the assertion: a regression fails here in 2s rather
        // than hanging the suite.
        const response = await fetch(`${baseUrl}${SIZED_AVATAR_PATH}`, {
          signal: AbortSignal.timeout(CLIENT_DEADLINE_MS),
        });
        expect(response.status).toBe(502);
        await expect(response.json()).resolves.toEqual({ error: 'Upstream read failed' });
      });

      expect(recorded.map((error) => error.message)).toEqual([]);
    } finally {
      await closeServer(server);
    }

    // Headers were still unsent here, so the 502 branch is reachable — and the
    // failure still has to reach Sentry.
    expect(errorSpy).toHaveBeenCalledWith(
      'Upstream read failed',
      expect.objectContaining({ source: `avatars/${AVATAR_FILE}`, headersSent: false }),
      expect.any(Error),
    );
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
    // The other half of the classification: a tab close must NOT page. If this
    // ever logs at `error`, every closed tab becomes a Sentry event.
    expect(infoSpy).toHaveBeenCalledWith(
      'Stream to client aborted',
      expect.objectContaining({ route: THUMBNAIL_PATH }),
    );
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
