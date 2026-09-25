import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { recordUncaughtExceptions } from './helpers/uncaught-exceptions';

const validateTokenMock = vi.hoisted(() => vi.fn());
const isS3ConfiguredMock = vi.hoisted(() => vi.fn(() => true));
const uploadToS3Mock = vi.hoisted(() => vi.fn());

vi.mock('../middleware/auth', () => ({
  validateToken: validateTokenMock,
}));

vi.mock('../storage/s3', async () => {
  const actual = await vi.importActual<typeof import('../storage/s3')>('../storage/s3');
  return { ...actual, isS3Configured: isS3ConfiguredMock, uploadToS3: uploadToS3Mock };
});

const { handleAvatarUpload } = await import('../handlers/avatars');
const { handleFeedbackScreenshotUpload } = await import('../handlers/feedback-screenshots');
const { logger } = await import('../utils/logger');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const BOUNDARY = 'boardsesh5359boundary';

/**
 * A complete, ordinary multipart POST that busboy cannot finish parsing: a
 * well-formed prologue and file part with **no closing boundary**. `fetch`
 * derives an accurate `Content-Length` from the body, so this is not an abort,
 * a truncated socket, or a network fault — the server reads every byte the
 * client promised and busboy still ends mid-part.
 *
 * busboy answers that with `Unexpected end of form` on the parser *and*
 * `fileStream.destroy(...)` on the per-file stream. The parser error has a
 * listener; before #5359 the file stream did not, so Node rethrew it from a
 * `nextTick` and — with no `process.on('uncaughtException')` in the backend —
 * the replica exited, taking every graphql-ws session with it.
 */
function unterminatedMultipartBody(fileField: string): string {
  return [
    `--${BOUNDARY}`,
    'Content-Disposition: form-data; name="userId"',
    '',
    USER_ID,
    `--${BOUNDARY}`,
    `Content-Disposition: form-data; name="${fileField}"; filename="avatar.png"`,
    'Content-Type: image/png',
    '',
    'PNGBYTESPNGBYTESPNGBYTES',
  ].join('\r\n');
}

async function startServer(handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
  const server = createServer((req, res) => {
    void handle(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, server };
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Bounded so a handler that never answers fails fast instead of hanging. */
const CLIENT_DEADLINE_MS = 3000;

beforeEach(() => {
  validateTokenMock.mockResolvedValue({ userId: USER_ID });
  isS3ConfiguredMock.mockReturnValue(true);
  vi.spyOn(logger, 'warn').mockImplementation(() => logger);
  vi.spyOn(logger, 'error').mockImplementation(() => logger);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('multipart upload: a part busboy cannot finish parsing', () => {
  it('answers the avatar upload with 400 and never reaches uncaughtException', async () => {
    const { baseUrl, server } = await startServer((req, res) => handleAvatarUpload(req, res));

    let status: number | undefined;
    try {
      const recorded = await recordUncaughtExceptions(async () => {
        const response = await fetch(`${baseUrl}/api/avatars`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer upload-token',
            'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
          },
          body: unterminatedMultipartBody('avatar'),
          signal: AbortSignal.timeout(CLIENT_DEADLINE_MS),
        });
        status = response.status;
        await response.text();
      });

      // The oracle. Production installs no uncaughtException handler, so a
      // single entry here is a replica exit in prod.
      expect(recorded.map((error) => error.message)).toEqual([]);
    } finally {
      await closeServer(server);
    }

    // The rejected upload still answers, rather than holding the connection.
    expect(status).toBe(400);
  });

  it('logs the failed part with its route and field instead of throwing it', async () => {
    const { baseUrl, server } = await startServer((req, res) => handleAvatarUpload(req, res));

    try {
      await recordUncaughtExceptions(async () => {
        const response = await fetch(`${baseUrl}/api/avatars`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer upload-token',
            'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
          },
          body: unterminatedMultipartBody('avatar'),
          signal: AbortSignal.timeout(CLIENT_DEADLINE_MS),
        });
        await response.text();
      });
    } finally {
      await closeServer(server);
    }

    expect(logger.warn).toHaveBeenCalledWith(
      'Upload file stream failed',
      expect.objectContaining({ route: '/api/avatars', field: 'avatar' }),
      expect.any(Error),
    );
  });

  it('answers the feedback-screenshot upload with 400 and never reaches uncaughtException', async () => {
    const { baseUrl, server } = await startServer((req, res) => handleFeedbackScreenshotUpload(req, res));

    let status: number | undefined;
    try {
      const recorded = await recordUncaughtExceptions(async () => {
        const response = await fetch(`${baseUrl}/api/feedback-screenshots`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer upload-token',
            'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
          },
          body: unterminatedMultipartBody('screenshot'),
          signal: AbortSignal.timeout(CLIENT_DEADLINE_MS),
        });
        status = response.status;
        await response.text();
      });

      expect(recorded.map((error) => error.message)).toEqual([]);
    } finally {
      await closeServer(server);
    }

    expect(status).toBe(400);
  });
});
