import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
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

vi.mock('../storage/s3', () => ({
  isS3Configured: isS3ConfiguredMock,
  uploadToS3: uploadToS3Mock,
}));

const { handleOcrTestDataUpload } = await import('../handlers/ocr-test-data');

/**
 * Real-HTTP coverage for POST /api/ocr-test-data. The boundary pinned here is
 * the order of checks: an unauthenticated caller must get 401 whether or not
 * the private bucket is configured, so the response never reveals storage state.
 */

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0xff, 0xd9]);
const VALID_METADATA = { layoutId: 1, angle: 40, climb: { name: 'Test climb' } };

async function startOcrServer(): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname === '/api/ocr-test-data' && req.method === 'POST') {
        await handleOcrTestDataUpload(req, res);
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

function uploadScreenshot(baseUrl: string, token?: string): Promise<Response> {
  const formData = new FormData();
  formData.set('metadata', JSON.stringify(VALID_METADATA));
  formData.set('image', new Blob([JPEG_BYTES], { type: 'image/jpeg' }), 'screenshot.jpg');
  return fetch(`${baseUrl}/api/ocr-test-data`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: formData,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  isS3ConfiguredMock.mockReturnValue(true);
  uploadToS3Mock.mockResolvedValue(undefined);
  validateTokenMock.mockResolvedValue({ userId: 'ocr-uploader' });
});

describe('POST /api/ocr-test-data', () => {
  it('answers an unauthenticated caller 401 when the bucket is not configured', async () => {
    isS3ConfiguredMock.mockReturnValue(false);
    const { baseUrl, server } = await startOcrServer();
    try {
      const response = await uploadScreenshot(baseUrl);
      expect(response.status).toBe(401);
      expect(uploadToS3Mock).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it('answers an invalid token 401 when the bucket is not configured', async () => {
    isS3ConfiguredMock.mockReturnValue(false);
    validateTokenMock.mockResolvedValue(null);
    const { baseUrl, server } = await startOcrServer();
    try {
      const response = await uploadScreenshot(baseUrl, 'bad');
      expect(response.status).toBe(401);
      expect(uploadToS3Mock).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it('skips for a valid token when the bucket is not configured', async () => {
    isS3ConfiguredMock.mockReturnValue(false);
    const { baseUrl, server } = await startOcrServer();
    try {
      const response = await uploadScreenshot(baseUrl, 'good');
      expect(response.status).toBe(200);
      const body = (await response.json()) as { skipped?: boolean };
      expect(body.skipped).toBe(true);
      expect(validateTokenMock).toHaveBeenCalledTimes(1);
      expect(uploadToS3Mock).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it('stores image and metadata under one folder for a valid token', async () => {
    const { baseUrl, server } = await startOcrServer();
    try {
      const response = await uploadScreenshot(baseUrl, 'good');
      expect(response.status).toBe(200);
      const body = (await response.json()) as { folder?: string };
      expect(body.folder).toBeTruthy();
      expect(uploadToS3Mock).toHaveBeenCalledTimes(2);
      for (const call of uploadToS3Mock.mock.calls) {
        expect(call[2].startsWith(`moonboard-ocr-test-data/${body.folder}/`)).toBe(true);
      }
    } finally {
      await closeServer(server);
    }
  });

  it('answers an unauthenticated caller 401 when the bucket is configured', async () => {
    const { baseUrl, server } = await startOcrServer();
    try {
      const response = await uploadScreenshot(baseUrl);
      expect(response.status).toBe(401);
      expect(uploadToS3Mock).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });
});
