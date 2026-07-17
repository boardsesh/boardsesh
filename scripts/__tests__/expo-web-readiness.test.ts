import { describe, expect, it, vi } from 'vitest';

import { extractExpoWebEntryBundleSource, type ExpoWebFetch, prewarmExpoWeb } from '../lib/expo-web-readiness';

const entryBundlePath =
  '/packages/mobile/node_modules/expo-router/entry.bundle?platform=web&dev=false&hot=false&transform.baseUrl=%2Fapp';

function response(body: string, status = 200): Response {
  return new Response(body, { status, statusText: status === 200 ? 'OK' : 'Server Error' });
}

describe('extractExpoWebEntryBundleSource', () => {
  it('extracts and decodes Expo Router web entry bundle attributes', () => {
    const html = `<html><script src='/unrelated.js'></script><script defer src="${entryBundlePath.replaceAll('&', '&amp;')}"></script></html>`;

    expect(extractExpoWebEntryBundleSource(html)).toBe(entryBundlePath);
  });

  it('ignores scripts that are not the web entry bundle', () => {
    expect(extractExpoWebEntryBundleSource('<script src="/entry.bundle?platform=ios"></script>')).toBeNull();
  });
});

describe('prewarmExpoWeb', () => {
  it('waits for the shell, then fetches and consumes the Metro entry bundle', async () => {
    const bundleArrayBuffer = vi.fn(async () => new ArrayBuffer(1));
    const fetchImpl = vi
      .fn<ExpoWebFetch>()
      .mockResolvedValueOnce(response(`<script src="${entryBundlePath}"></script>`))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: vi.fn(),
        arrayBuffer: bundleArrayBuffer,
      });

    await expect(prewarmExpoWeb({ origin: 'http://localhost:8082', fetchImpl, timeoutMs: 1_000 })).resolves.toEqual({
      shellUrl: 'http://localhost:8082/app',
      bundleUrl: `http://localhost:8082${entryBundlePath}`,
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'http://localhost:8082/app',
      expect.objectContaining({ cache: 'no-store' }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      `http://localhost:8082${entryBundlePath}`,
      expect.objectContaining({ cache: 'no-store' }),
    );
    expect(bundleArrayBuffer).toHaveBeenCalledOnce();
  });

  it('retries connection failures until Expo begins serving the shell', async () => {
    let nowMs = 0;
    const fetchImpl = vi
      .fn<ExpoWebFetch>()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce(response(`<script src="${entryBundlePath}"></script>`))
      .mockResolvedValueOnce(response('bundle'));

    await prewarmExpoWeb({
      origin: 'http://localhost:8082/',
      fetchImpl,
      timeoutMs: 1_000,
      retryIntervalMs: 50,
      now: () => nowMs,
      sleep: async (milliseconds) => {
        nowMs += milliseconds;
      },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('fails with the last connection error after a bounded timeout', async () => {
    let nowMs = 0;
    const fetchImpl = vi.fn<ExpoWebFetch>().mockRejectedValue(new Error('connection refused'));

    await expect(
      prewarmExpoWeb({
        origin: 'http://localhost:8082',
        fetchImpl,
        timeoutMs: 100,
        retryIntervalMs: 25,
        now: () => nowMs,
        sleep: async (milliseconds) => {
          nowMs += milliseconds;
        },
      }),
    ).rejects.toThrow(
      'Expo web did not become ready at http://localhost:8082/app within 100ms. Last failure: connection refused.',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('reports a process exit immediately', async () => {
    await expect(
      prewarmExpoWeb({
        origin: 'http://localhost:8082',
        isProcessRunning: () => false,
      }),
    ).rejects.toThrow('Expo web exited before its browser bundle was ready');
  });

  it('reports a malformed Expo shell without waiting for the timeout', async () => {
    const fetchImpl = vi.fn<ExpoWebFetch>().mockResolvedValue(response('<html>No entry script</html>'));

    await expect(prewarmExpoWeb({ origin: 'http://localhost:8082', fetchImpl })).rejects.toThrow(
      'did not contain the Expo Router web entry bundle',
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
