import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';

const validateTokenMock = vi.hoisted(() => vi.fn());
const isS3ConfiguredMock = vi.hoisted(() => vi.fn(() => true));
const uploadToS3Mock = vi.hoisted(() =>
  vi.fn(async (_bucket: string, _body: Buffer, _key: string, _contentType: string): Promise<void> => undefined),
);

vi.mock('../middleware/auth', () => ({
  validateToken: validateTokenMock,
}));

// This handler has no local-disk fallback: it either writes to the private
// bucket or reports itself skipped, so the storage module is mocked for every
// case and isS3Configured is the switch between the two.
vi.mock('../storage/s3', () => ({
  isS3Configured: isS3ConfiguredMock,
  uploadToS3: uploadToS3Mock,
}));

const { handleSprayWallTestDataUpload } = await import('../handlers/spray-wall-test-data');

/**
 * Real-HTTP coverage for POST /api/spray-wall-test-data — the Discord-sourced
 * hold-detection corpus intake. No database is involved. The two boundaries
 * worth pinning are the magic-byte check (an authenticated account must not be
 * able to park arbitrary bytes in our private bucket under an image extension)
 * and the metadata contract, since an entry with no wall facts is not a usable
 * training sample.
 */

const UPLOADER = 'spray-uploader';
const MAX_FILE_SIZE = 20 * 1024 * 1024;

// Smallest byte sequences that satisfy detectImageMimeType.
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0xff, 0xd9]);
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

const VALID_METADATA = {
  wall: { angle: 25, description: 'Home spray, mixed wood and plastic' },
  capture: { orientation: 'portrait', lighting: 'overhead LED', hardCases: ['glare', 'overlapping holds'] },
  consent: { redistribute: true },
};

async function startSprayWallServer(): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname === '/api/spray-wall-test-data' && req.method === 'POST') {
        await handleSprayWallTestDataUpload(req, res);
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

function uploadPhoto(
  baseUrl: string,
  opts: {
    token?: string;
    blob?: Blob;
    fieldName?: string;
    filename?: string;
    metadata?: string | null;
  } = {},
): Promise<Response> {
  const formData = new FormData();
  if (opts.metadata !== null) {
    formData.set('metadata', opts.metadata ?? JSON.stringify(VALID_METADATA));
  }
  formData.set(
    opts.fieldName ?? 'image',
    opts.blob ?? new Blob([JPEG_BYTES], { type: 'image/jpeg' }),
    opts.filename ?? 'spray-wall.jpg',
  );
  return fetch(`${baseUrl}/api/spray-wall-test-data`, {
    method: 'POST',
    headers: opts.token ? { Authorization: `Bearer ${opts.token}` } : {},
    body: formData,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  isS3ConfiguredMock.mockReturnValue(true);
  uploadToS3Mock.mockResolvedValue(undefined);
  validateTokenMock.mockResolvedValue({ userId: UPLOADER });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/spray-wall-test-data', () => {
  it('writes the photo and its metadata to the private bucket under one folder', async () => {
    const { baseUrl, server } = await startSprayWallServer();
    try {
      const response = await uploadPhoto(baseUrl, { token: 'uploader' });
      expect(response.status).toBe(200);

      const body = (await response.json()) as { success?: boolean; folder?: string };
      expect(body.success).toBe(true);
      expect(body.folder).toBeTruthy();

      expect(uploadToS3Mock).toHaveBeenCalledTimes(2);
      expect(uploadToS3Mock).toHaveBeenNthCalledWith(
        1,
        'private',
        JPEG_BYTES,
        `spray-wall-test-data/${body.folder}/image.jpg`,
        'image/jpeg',
      );

      const [bucket, metadataBuffer, metadataKey, contentType] = uploadToS3Mock.mock.calls[1];
      expect(bucket).toBe('private');
      expect(metadataKey).toBe(`spray-wall-test-data/${body.folder}/metadata.json`);
      expect(contentType).toBe('application/json');

      // The consent flag decides whether this photo can ever become a public
      // fixture, so it has to survive the round trip verbatim.
      const stored = JSON.parse(metadataBuffer.toString('utf-8')) as {
        wall?: { angle?: number };
        consent?: { redistribute?: boolean };
        imageMetadata?: { mimeType?: string; fileSize?: number; originalFilename?: string };
      };
      expect(stored.wall?.angle).toBe(25);
      expect(stored.consent?.redistribute).toBe(true);
      expect(stored.imageMetadata).toEqual({
        originalFilename: 'spray-wall.jpg',
        mimeType: 'image/jpeg',
        fileSize: JPEG_BYTES.length,
      });
    } finally {
      await closeServer(server);
    }
  });

  it('mints a fresh folder per upload rather than overwriting one', async () => {
    const { baseUrl, server } = await startSprayWallServer();
    try {
      const first = (await (await uploadPhoto(baseUrl, { token: 'uploader' })).json()) as { folder?: string };
      const second = (await (
        await uploadPhoto(baseUrl, {
          token: 'uploader',
          blob: new Blob([PNG_BYTES], { type: 'image/png' }),
          filename: 'spray-wall.png',
        })
      ).json()) as { folder?: string };

      expect(first.folder).not.toBe(second.folder);
      expect(uploadToS3Mock.mock.calls[2][2]).toBe(`spray-wall-test-data/${second.folder}/image.png`);
    } finally {
      await closeServer(server);
    }
  });

  it('accepts metadata carrying nothing but the wall object', async () => {
    const { baseUrl, server } = await startSprayWallServer();
    try {
      const response = await uploadPhoto(baseUrl, { token: 'uploader', metadata: JSON.stringify({ wall: {} }) });
      expect(response.status).toBe(200);
      expect(uploadToS3Mock).toHaveBeenCalledTimes(2);
    } finally {
      await closeServer(server);
    }
  });

  it('skips silently when the private bucket is not configured', async () => {
    isS3ConfiguredMock.mockReturnValue(false);
    const { baseUrl, server } = await startSprayWallServer();
    try {
      const response = await uploadPhoto(baseUrl, { token: 'uploader' });
      expect(response.status).toBe(200);

      const body = (await response.json()) as { success?: boolean; skipped?: boolean };
      expect(body.skipped).toBe(true);
      expect(uploadToS3Mock).not.toHaveBeenCalled();
      // The early-out happens before auth, so no token is ever inspected.
      expect(validateTokenMock).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it('requires a bearer token (401)', async () => {
    const { baseUrl, server } = await startSprayWallServer();
    try {
      const response = await uploadPhoto(baseUrl);
      expect(response.status).toBe(401);
      expect(validateTokenMock).not.toHaveBeenCalled();
      expect(uploadToS3Mock).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it('rejects a token the auth middleware does not recognise (401)', async () => {
    validateTokenMock.mockResolvedValue(null);
    const { baseUrl, server } = await startSprayWallServer();
    try {
      const response = await uploadPhoto(baseUrl, { token: 'expired' });
      expect(response.status).toBe(401);
      expect(uploadToS3Mock).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it('rejects a file over the 20MB cap (400)', async () => {
    const { baseUrl, server } = await startSprayWallServer();
    try {
      const oversized = Buffer.alloc(MAX_FILE_SIZE + 1024, 0);
      JPEG_BYTES.copy(oversized);
      const response = await uploadPhoto(baseUrl, {
        token: 'uploader',
        blob: new Blob([oversized], { type: 'image/jpeg' }),
      });
      expect(response.status).toBe(400);

      const body = (await response.json()) as { error?: string };
      expect(body.error).toContain('20MB');
      expect(uploadToS3Mock).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it('rejects a declared mime type outside the raster allowlist (400)', async () => {
    const { baseUrl, server } = await startSprayWallServer();
    try {
      const response = await uploadPhoto(baseUrl, {
        token: 'uploader',
        // An inline <svg> would execute script wherever the photo is rendered.
        blob: new Blob([Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" />')], { type: 'image/svg+xml' }),
        filename: 'spray-wall.svg',
      });
      expect(response.status).toBe(400);
      expect(uploadToS3Mock).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it('rejects bytes that contradict the declared image type (400)', async () => {
    const { baseUrl, server } = await startSprayWallServer();
    try {
      const response = await uploadPhoto(baseUrl, {
        token: 'uploader',
        blob: new Blob([Buffer.from('MZ this is a windows executable', 'latin1')], { type: 'image/png' }),
        filename: 'spray-wall.png',
      });
      expect(response.status).toBe(400);

      const body = (await response.json()) as { error?: string };
      expect(body.error).toContain('do not match');
      expect(uploadToS3Mock).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it('rejects a PNG payload declared as JPEG (400)', async () => {
    const { baseUrl, server } = await startSprayWallServer();
    try {
      const response = await uploadPhoto(baseUrl, {
        token: 'uploader',
        blob: new Blob([PNG_BYTES], { type: 'image/jpeg' }),
      });
      expect(response.status).toBe(400);
      expect(uploadToS3Mock).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it('rejects a submission with no metadata field (400)', async () => {
    const { baseUrl, server } = await startSprayWallServer();
    try {
      const response = await uploadPhoto(baseUrl, { token: 'uploader', metadata: null });
      expect(response.status).toBe(400);

      const body = (await response.json()) as { error?: string };
      expect(body.error).toContain('Metadata is required');
      expect(uploadToS3Mock).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it('rejects metadata that is not valid JSON (400)', async () => {
    const { baseUrl, server } = await startSprayWallServer();
    try {
      const response = await uploadPhoto(baseUrl, { token: 'uploader', metadata: '{not json' });
      expect(response.status).toBe(400);

      const body = (await response.json()) as { error?: string };
      expect(body.error).toContain('Invalid metadata JSON');
      expect(uploadToS3Mock).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it('rejects metadata with no wall object (400)', async () => {
    const { baseUrl, server } = await startSprayWallServer();
    try {
      const response = await uploadPhoto(baseUrl, {
        token: 'uploader',
        metadata: JSON.stringify({ consent: { redistribute: true } }),
      });
      expect(response.status).toBe(400);

      const body = (await response.json()) as { error?: string };
      expect(body.error).toContain('wall');
      expect(uploadToS3Mock).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it('rejects a submission with no image part (400)', async () => {
    const { baseUrl, server } = await startSprayWallServer();
    try {
      const response = await uploadPhoto(baseUrl, { token: 'uploader', fieldName: 'notTheImage' });
      expect(response.status).toBe(400);
      expect(uploadToS3Mock).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it('reports itself skipped rather than failing when the bucket write throws', async () => {
    uploadToS3Mock.mockRejectedValue(new Error('bucket unreachable'));
    const { baseUrl, server } = await startSprayWallServer();
    try {
      const response = await uploadPhoto(baseUrl, { token: 'uploader' });
      expect(response.status).toBe(200);

      const body = (await response.json()) as { success?: boolean; skipped?: boolean };
      expect(body.success).toBe(true);
      expect(body.skipped).toBe(true);
    } finally {
      await closeServer(server);
    }
  });
});
