import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { rm } from 'node:fs/promises';
import {
  FEEDBACK_SCREENSHOT_KEY_PATTERN,
  FEEDBACK_SCREENSHOT_MAX_UPLOAD_BYTES,
  FEEDBACK_SCREENSHOT_PREFIX,
} from '@boardsesh/shared-schema';

const validateTokenMock = vi.hoisted(() => vi.fn());
const isS3ConfiguredMock = vi.hoisted(() => vi.fn(() => false));
const uploadToS3Mock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('../middleware/auth', () => ({
  validateToken: validateTokenMock,
}));

// Every other case runs the local-disk branch. Mocking the storage module lets
// one case take the branch production actually takes, so a signature change to
// uploadToS3 cannot pass here and fail in the bucket.
vi.mock('../storage/s3', () => ({
  isS3Configured: isS3ConfiguredMock,
  uploadToS3: uploadToS3Mock,
}));

const { handleFeedbackScreenshotUpload, resetFeedbackScreenshotRateLimit } =
  await import('../handlers/feedback-screenshots');

/** Mirrors the handler's own local-dev directory, used only to clean up after. */
const LOCAL_UPLOAD_DIR = `./${FEEDBACK_SCREENSHOT_PREFIX}`;

/**
 * Real-HTTP coverage for POST /api/feedback-screenshots. No database is
 * involved: the endpoint authenticates, spends a per-user upload budget, and
 * writes one immutable object. The two things worth pinning are the magic-byte
 * check (the boundary that stops an authenticated account hosting arbitrary
 * bytes on our public media domain) and the rate limit (which stops it filling
 * the bucket one valid PNG at a time).
 */

const UPLOADER = 'fs-uploader';

// Smallest byte sequences that satisfy detectImageMimeType.
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0xff, 0xd9]);
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

async function startScreenshotServer(): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname === '/api/feedback-screenshots' && req.method === 'POST') {
        await handleFeedbackScreenshotUpload(req, res);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    })().catch((error: unknown) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, server };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function uploadScreenshot(
  baseUrl: string,
  opts: { token?: string; blob?: Blob; fieldName?: string } = {},
): Promise<Response> {
  const formData = new FormData();
  formData.set(
    opts.fieldName ?? 'screenshot',
    opts.blob ?? new Blob([JPEG_BYTES], { type: 'image/jpeg' }),
    'screenshot.jpg',
  );
  return fetch(`${baseUrl}/api/feedback-screenshots`, {
    method: 'POST',
    headers: opts.token ? { Authorization: `Bearer ${opts.token}` } : {},
    body: formData,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetFeedbackScreenshotRateLimit();
  validateTokenMock.mockResolvedValue({ userId: UPLOADER });
});

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  await rm(LOCAL_UPLOAD_DIR, { recursive: true, force: true });
});

describe('POST /api/feedback-screenshots', () => {
  it('stores the image and returns a key this system could have minted', async () => {
    const { baseUrl, server } = await startScreenshotServer();
    try {
      const response = await uploadScreenshot(baseUrl, { token: 'uploader' });
      expect(response.status).toBe(200);

      const body = (await response.json()) as { success?: boolean; key?: string };
      expect(body.success).toBe(true);
      // The key is the trust boundary — the resolver only renders keys matching
      // this shape, so an upload that minted anything else would be unusable.
      expect(body.key).toMatch(FEEDBACK_SCREENSHOT_KEY_PATTERN);
    } finally {
      await closeServer(server);
    }
  });

  it('writes the object to the media bucket when S3 is configured', async () => {
    isS3ConfiguredMock.mockReturnValue(true);
    const { baseUrl, server } = await startScreenshotServer();
    try {
      const response = await uploadScreenshot(baseUrl, { token: 'uploader' });
      expect(response.status).toBe(200);

      const { key } = (await response.json()) as { key: string };
      expect(uploadToS3Mock).toHaveBeenCalledTimes(1);
      // Bucket, bytes, the key we handed the client, and the sniffed type — the
      // key is immutable, so no resize variants are written alongside it.
      expect(uploadToS3Mock).toHaveBeenCalledWith('media', JPEG_BYTES, key, 'image/jpeg');
    } finally {
      isS3ConfiguredMock.mockReturnValue(false);
      await closeServer(server);
    }
  });

  it('mints a fresh key per upload rather than overwriting one', async () => {
    const { baseUrl, server } = await startScreenshotServer();
    try {
      const first = (await (await uploadScreenshot(baseUrl, { token: 'uploader' })).json()) as { key?: string };
      const second = (await (
        await uploadScreenshot(baseUrl, {
          token: 'uploader',
          blob: new Blob([PNG_BYTES], { type: 'image/png' }),
        })
      ).json()) as { key?: string };

      expect(first.key).not.toBe(second.key);
      expect(second.key).toMatch(/\.png$/);
    } finally {
      await closeServer(server);
    }
  });

  it('requires a bearer token (401)', async () => {
    const { baseUrl, server } = await startScreenshotServer();
    try {
      const response = await uploadScreenshot(baseUrl);
      expect(response.status).toBe(401);
      expect(validateTokenMock).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it('rejects a token the auth middleware does not recognise (401)', async () => {
    validateTokenMock.mockResolvedValue(null);
    const { baseUrl, server } = await startScreenshotServer();
    try {
      const response = await uploadScreenshot(baseUrl, { token: 'expired' });
      expect(response.status).toBe(401);
    } finally {
      await closeServer(server);
    }
  });

  it('rejects a declared mime type outside the raster allowlist (400)', async () => {
    const { baseUrl, server } = await startScreenshotServer();
    try {
      const response = await uploadScreenshot(baseUrl, {
        token: 'uploader',
        // An inline <svg> would execute script wherever the attachment renders.
        blob: new Blob([Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" />')], { type: 'image/svg+xml' }),
      });
      expect(response.status).toBe(400);
    } finally {
      await closeServer(server);
    }
  });

  it('rejects bytes that contradict the declared image type (400)', async () => {
    const { baseUrl, server } = await startScreenshotServer();
    try {
      const response = await uploadScreenshot(baseUrl, {
        token: 'uploader',
        blob: new Blob([Buffer.from('MZ this is a windows executable', 'latin1')], { type: 'image/png' }),
      });
      expect(response.status).toBe(400);

      const body = (await response.json()) as { error?: string };
      expect(body.error).toContain('do not match');
    } finally {
      await closeServer(server);
    }
  });

  it('rejects a file over the size cap (400)', async () => {
    const { baseUrl, server } = await startScreenshotServer();
    try {
      const oversized = Buffer.alloc(FEEDBACK_SCREENSHOT_MAX_UPLOAD_BYTES + 1024, 0);
      JPEG_BYTES.copy(oversized);
      const response = await uploadScreenshot(baseUrl, {
        token: 'uploader',
        blob: new Blob([oversized], { type: 'image/jpeg' }),
      });
      expect(response.status).toBe(400);

      const body = (await response.json()) as { error?: string };
      expect(body.error).toContain('5MB');
    } finally {
      await closeServer(server);
    }
  });

  it('rejects a zero-byte part rather than storing a broken image (400)', async () => {
    const { baseUrl, server } = await startScreenshotServer();
    try {
      const response = await uploadScreenshot(baseUrl, {
        token: 'uploader',
        blob: new Blob([], { type: 'image/png' }),
      });
      expect(response.status).toBe(400);
    } finally {
      await closeServer(server);
    }
  });

  it('rejects a submission with no screenshot part (400)', async () => {
    const { baseUrl, server } = await startScreenshotServer();
    try {
      const response = await uploadScreenshot(baseUrl, { token: 'uploader', fieldName: 'notTheScreenshot' });
      expect(response.status).toBe(400);
    } finally {
      await closeServer(server);
    }
  });

  it('caps a single user at 20 uploads per window (429)', async () => {
    const { baseUrl, server } = await startScreenshotServer();
    try {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const response = await uploadScreenshot(baseUrl, { token: 'uploader' });
        expect(response.status).toBe(200);
      }

      const overLimit = await uploadScreenshot(baseUrl, { token: 'uploader' });
      expect(overLimit.status).toBe(429);
    } finally {
      await closeServer(server);
    }
  });
});
