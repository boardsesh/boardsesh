import { afterAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createServer, request, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { readdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { Readable } from 'node:stream';
import { FEEDBACK_RECORDING_KEY_PATTERN, FEEDBACK_RECORDING_MAX_UPLOAD_BYTES } from '@boardsesh/shared-schema';

const failDiskWrite = vi.hoisted(() => ({ enabled: false }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { Writable } = await import('node:stream');
  return {
    ...actual,
    createWriteStream: (...arguments_: Parameters<typeof actual.createWriteStream>) => {
      if (!failDiskWrite.enabled) return actual.createWriteStream(...arguments_);
      failDiskWrite.enabled = false;
      return new Writable({
        write(_chunk, _encoding, callback) {
          callback(new Error('Disk full'));
        },
      });
    },
  };
});
const auth = vi.hoisted(() => vi.fn());
const configured = vi.hoisted(() => vi.fn(() => false));
const uploaded = vi.hoisted(() =>
  vi.fn(
    async (_bucket: string, _body: Readable, _length: number, _key: string, _type: string, _signal?: AbortSignal) =>
      undefined,
  ),
);
vi.mock('../middleware/auth', () => ({ validateToken: auth }));
vi.mock('../storage/s3', () => ({ isS3Configured: configured, uploadStreamToS3: uploaded }));
const { handleFeedbackRecordingUpload, resetFeedbackRecordingRateLimit, detectRecordingMimeType } =
  await import('../handlers/feedback-recordings');

const mp4 = Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex');
const mov = Buffer.from('0000001466747970717420200000000071742020', 'hex');
const webm = Buffer.from('1a45dfa3894282847765626d', 'hex');
let server: Server;
let baseUrl: string;
const createdKeys: string[] = [];
beforeEach(async () => {
  vi.clearAllMocks();
  resetFeedbackRecordingRateLimit();
  configured.mockReturnValue(false);
  failDiskWrite.enabled = false;
  auth.mockResolvedValue({ userId: 'recording-tester' });
  if (!server) {
    server = createServer((req, res) => {
      void handleFeedbackRecordingUpload(req, res).catch(() => res.destroy());
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.all(createdKeys.map((key) => rm(key, { force: true })));
});
function upload(bytes: Buffer = mp4, type = 'video/mp4', extra?: 'file' | 'field') {
  const form = new FormData();
  form.append('recording', new Blob([new Uint8Array(bytes)], { type }), 'recording.mp4');
  if (extra === 'file') form.append('recording', new Blob([new Uint8Array(mp4)], { type: 'video/mp4' }), 'second.mp4');
  if (extra === 'field') form.append('unexpected', 'extra');
  return fetch(baseUrl, { method: 'POST', headers: { Authorization: 'Bearer valid' }, body: form });
}
async function temporaryFiles() {
  return (await readdir(tmpdir())).filter((filename) => filename.startsWith('boardsesh-feedback-recording-')).sort();
}
describe('recording uploads', () => {
  it.each([
    [mp4, 'video/mp4'],
    [mov, 'video/quicktime'],
    [webm, 'video/webm'],
  ])('stores the original %s container', async (bytes, type) => {
    const before = await temporaryFiles();
    const response = await upload(bytes, type);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; key: string };
    expect(body.success).toBe(true);
    createdKeys.push(body.key);
    expect(body.key).toMatch(FEEDBACK_RECORDING_KEY_PATTERN);
    expect(await readFile(body.key)).toEqual(bytes);
    await vi.waitFor(async () => expect(await temporaryFiles()).toEqual(before));
  });
  it('passes a stream, exact byte length, and abort signal to public storage', async () => {
    configured.mockReturnValue(true);
    uploaded.mockImplementationOnce(async (_bucket, body, length) => {
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(chunk as Buffer);
      expect(Buffer.concat(chunks)).toEqual(mp4);
      expect(length).toBe(mp4.length);
    });
    expect((await upload()).status).toBe(200);
    expect(uploaded).toHaveBeenCalledWith(
      'media',
      expect.anything(),
      mp4.length,
      expect.stringMatching(FEEDBACK_RECORDING_KEY_PATTERN),
      'video/mp4',
      expect.any(AbortSignal),
    );
  });
  it('requires a signed-in account', async () => {
    const response = await fetch(baseUrl, { method: 'POST', body: 'ignored' });
    expect(response.status).toBe(401);
    expect(auth).not.toHaveBeenCalled();
    auth.mockResolvedValue(null);
    expect((await upload()).status).toBe(401);
  });
  it.each([
    [mp4, 'video/quicktime'],
    [mov, 'video/mp4'],
    [Buffer.from('script'), 'video/mp4'],
    [Buffer.alloc(0), 'video/webm'],
    [mp4, 'application/octet-stream'],
  ])('rejects mismatched or empty %s payloads', async (bytes, type) => {
    expect((await upload(bytes, type)).status).toBe(400);
    expect(uploaded).not.toHaveBeenCalled();
  });
  it.each(['file', 'field'] as const)('rejects an extra %s', async (extra) => {
    expect((await upload(mp4, 'video/mp4', extra)).status).toBe(400);
  });
  it('counts failed attempts against the eight-attempt upload budget', async () => {
    for (let attempt = 0; attempt < 8; attempt++) expect((await upload(Buffer.from('invalid'))).status).toBe(400);
    expect((await upload()).status).toBe(429);
  });
  it('answers and cleans a disk write failure before the multipart body ends', async () => {
    const before = await temporaryFiles();
    failDiskWrite.enabled = true;
    const response = await new Promise<{ status: number }>((resolve, reject) => {
      const client = request(
        baseUrl,
        {
          method: 'POST',
          headers: { Authorization: 'Bearer valid', 'Content-Type': 'multipart/form-data; boundary=disk-failure' },
        },
        (incoming) => {
          incoming.resume();
          incoming.once('end', () => {
            resolve({ status: incoming.statusCode ?? 0 });
            client.destroy();
          });
        },
      );
      client.on('error', reject);
      client.write(
        '--disk-failure\r\nContent-Disposition: form-data; name="recording"; filename="r.mp4"\r\nContent-Type: video/mp4\r\n\r\n',
      );
      client.write(Buffer.alloc(512 * 1024));
      // Leave the chunked request unfinished: disk failure must still settle.
    });
    expect(response.status).toBe(500);
    await vi.waitFor(async () => expect(await temporaryFiles()).toEqual(before));
    expect(uploaded).not.toHaveBeenCalled();
  });

  it('removes temporary bytes after a storage failure', async () => {
    const before = await temporaryFiles();
    configured.mockReturnValue(true);
    uploaded.mockRejectedValueOnce(new Error('storage unavailable'));
    expect((await upload()).status).toBe(500);
    await vi.waitFor(async () => expect(await temporaryFiles()).toEqual(before));
  });
  it('rejects malformed multipart and cleans the disk stream', async () => {
    const before = await temporaryFiles();
    const boundary = 'broken';
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: { Authorization: 'Bearer valid', 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: `--${boundary}\r\nContent-Disposition: form-data; name="recording"; filename="r.mp4"\r\nContent-Type: video/mp4\r\n\r\nunterminated`,
    });
    expect(response.status).toBe(400);
    await vi.waitFor(async () => expect(await temporaryFiles()).toEqual(before));
  });
  it('cleans temporary bytes after an interrupted upload', async () => {
    const before = await temporaryFiles();
    const client = request(baseUrl, {
      method: 'POST',
      headers: { Authorization: 'Bearer valid', 'Content-Type': 'multipart/form-data; boundary=abort' },
    });
    client.on('error', () => undefined);
    client.write(
      '--abort\r\nContent-Disposition: form-data; name="recording"; filename="r.mp4"\r\nContent-Type: video/mp4\r\n\r\n',
    );
    client.write(mp4);
    await vi.waitFor(async () => expect((await temporaryFiles()).length).toBeGreaterThan(before.length));
    client.destroy();
    await vi.waitFor(async () => expect(await temporaryFiles()).toEqual(before));
    expect(uploaded).not.toHaveBeenCalled();
  });
  it('accepts the exact cap and rejects one extra byte', async () => {
    configured.mockReturnValue(true);
    uploaded.mockImplementationOnce(async (_bucket, body, length) => {
      expect(length).toBe(FEEDBACK_RECORDING_MAX_UPLOAD_BYTES);
      let received = 0;
      for await (const chunk of body) received += (chunk as Buffer).length;
      expect(received).toBe(length);
    });
    const bytes = Buffer.alloc(FEEDBACK_RECORDING_MAX_UPLOAD_BYTES + 1);
    mp4.copy(bytes);
    expect((await upload(bytes.subarray(0, FEEDBACK_RECORDING_MAX_UPLOAD_BYTES))).status).toBe(200);
    expect((await upload(bytes)).status).toBe(400);
    expect(uploaded).toHaveBeenCalledTimes(1);
  }, 30000);
});
describe('container sniffing', () => {
  it('rejects Matroska and malformed ISO box lengths', () => {
    expect(detectRecordingMimeType(Buffer.from('1a45dfa38c4282876d6174726f736b61', 'hex'))).toBeNull();
    const malformed = Buffer.from(mp4);
    malformed.writeUInt32BE(200, 0);
    expect(detectRecordingMimeType(malformed)).toBeNull();
  });
});
