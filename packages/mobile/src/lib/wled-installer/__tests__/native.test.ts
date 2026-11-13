import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  fetch: vi.fn(),
  createUploadTask: vi.fn(),
  upload: vi.fn(),
  cancel: vi.fn(),
  write: vi.fn(),
  digest: vi.fn(),
  share: vi.fn(),
}));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-file-system', () => ({
  File: class {
    write = runtime.write;
  },
}));
vi.mock('../legacy', () => ({
  documentDirectory: 'file:///documents/',
  cacheDirectory: 'file:///cache/',
  makeDirectoryAsync: vi.fn(),
  writeAsStringAsync: vi.fn(),
  readAsStringAsync: vi.fn(),
  getInfoAsync: vi.fn(async () => ({ exists: false })),
  deleteAsync: vi.fn(),
  createUploadTask: runtime.createUploadTask,
  FileSystemUploadType: { MULTIPART: 1 },
  FileSystemSessionType: { FOREGROUND: 1 },
}));
vi.mock('expo-crypto', () => ({ digest: runtime.digest, CryptoDigestAlgorithm: { SHA256: 'SHA-256' } }));
vi.mock('expo-keep-awake', () => ({ activateKeepAwakeAsync: vi.fn(), deactivateKeepAwake: vi.fn() }));
vi.mock('expo-sharing', () => ({ shareAsync: runtime.share }));
import { nativeInstallerIO } from '../native';
import type { FirmwareRelease } from '../engine';
const release = {
  url: 'https://example.com/firmware.bin',
  imageBytes: 3,
  sha256: 'ab'.repeat(32),
} as FirmwareRelease;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', runtime.fetch);
  runtime.createUploadTask.mockReturnValue({ uploadAsync: runtime.upload, cancelAsync: runtime.cancel });
  runtime.upload.mockResolvedValue({ status: 200, body: 'update accepted' });
  runtime.cancel.mockResolvedValue(undefined);
  runtime.digest.mockResolvedValue(new Uint8Array(32).fill(171).buffer);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('native WLED installer IO', () => {
  it('uploads native multipart only to the normalized local /update endpoint', async () => {
    const progress = vi.fn();
    await nativeInstallerIO.upload('192.168.1.5', 'file:///firmware.bin', new AbortController().signal, progress);
    expect(runtime.createUploadTask).toHaveBeenCalledWith(
      'http://192.168.1.5/update',
      'file:///firmware.bin',
      {
        httpMethod: 'POST',
        uploadType: 1,
        fieldName: 'update',
        mimeType: 'application/octet-stream',
        sessionType: 1,
        headers: { Accept: 'text/html' },
      },
      expect.any(Function),
    );
    const callback = runtime.createUploadTask.mock.calls[0][3] as (event: {
      totalBytesSent: number;
      totalBytesExpectedToSend: number;
    }) => void;
    callback({ totalBytesSent: 50, totalBytesExpectedToSend: 100 });
    expect(progress).toHaveBeenCalledWith(0.5);
  });
  it('refuses public controller IPs before native upload', async () => {
    await expect(
      nativeInstallerIO.upload('https://example.com', 'file:///firmware.bin', new AbortController().signal, vi.fn()),
    ).rejects.toThrow();
    expect(runtime.createUploadTask).not.toHaveBeenCalled();
  });
  it('does not bypass PIN or OTA locks', async () => {
    runtime.fetch.mockResolvedValue({ ok: false, status: 401 });
    await expect(
      nativeInstallerIO.checkUpdateAccess('192.168.1.5', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'locked' });
    expect(runtime.fetch).toHaveBeenCalledWith(
      'http://192.168.1.5/update',
      expect.objectContaining({ credentials: 'omit', redirect: 'error', headers: { Accept: 'application/json' } }),
    );
    runtime.upload.mockResolvedValue({ status: 401 });
    await expect(
      nativeInstallerIO.upload('192.168.1.5', 'file:///firmware.bin', new AbortController().signal, vi.fn()),
    ).rejects.toMatchObject({ code: 'locked' });
  });
  it('cancels the native task when the owner leaves', async () => {
    let finish: ((result: { status: number }) => void) | undefined;
    runtime.upload.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const controller = new AbortController();
    const pending = nativeInstallerIO.upload('192.168.1.5', 'file:///firmware.bin', controller.signal, vi.fn());
    controller.abort();
    expect(runtime.cancel).toHaveBeenCalledOnce();
    finish?.({ status: 200 });
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  });
  it('checks size and SHA256 before persisting downloaded firmware', async () => {
    runtime.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': '3' }),
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });
    const downloaded = await nativeInstallerIO.download(release, new AbortController().signal);
    expect(downloaded).toMatchObject({ bytes: 3, sha256: release.sha256 });
    expect(runtime.digest).toHaveBeenCalledWith('SHA-256', new Uint8Array([1, 2, 3]).buffer);
    expect(runtime.write).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
  });
  it('does not persist a bad checksum or incorrect image length', async () => {
    runtime.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });
    runtime.digest.mockResolvedValue(new Uint8Array(32).fill(0).buffer);
    await expect(nativeInstallerIO.download(release, new AbortController().signal)).rejects.toMatchObject({
      code: 'checksum',
    });
    expect(runtime.write).not.toHaveBeenCalled();
    await expect(
      nativeInstallerIO.download({ ...release, imageBytes: 5 }, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'imageSize' });
  });
  it('rejects plaintext image downloads before network access', async () => {
    await expect(
      nativeInstallerIO.download({ ...release, url: 'http://example.com/firmware.bin' }, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'incompatible' });
    expect(runtime.fetch).not.toHaveBeenCalled();
  });
  it('keeps request deadlines active while a JSON response body is pending', async () => {
    vi.useFakeTimers();
    runtime.fetch.mockImplementation(async (_url, options: RequestInit) => ({
      ok: true,
      status: 200,
      json: () =>
        new Promise((_resolve, reject) =>
          options.signal?.addEventListener('abort', () => reject(new Error('body aborted'))),
        ),
    }));
    const pending = nativeInstallerIO.readJson('http://192.168.1.5/json/info', new AbortController().signal);
    const rejected = expect(pending).rejects.toThrow('body aborted');
    await vi.advanceTimersByTimeAsync(8000);
    await rejected;
  });
  it('never uploads a task after prior cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      nativeInstallerIO.upload('192.168.1.5', 'file:///firmware.bin', controller.signal, vi.fn()),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(runtime.createUploadTask).not.toHaveBeenCalled();
  });
});
