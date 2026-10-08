/// <reference types="node" />

import { afterEach, describe, expect, it, vi } from 'vitest';
import { servedManifest } from '../mobile-ota-boot-check';

const options = { platform: 'ios' as const, branch: 'pr-staging', manifestUrl: 'https://example.test/manifest' };
const runtimeVersion = 'a'.repeat(40);

afterEach(() => vi.useRealTimers());

describe('boot-check manifest deadline', () => {
  it('bounds a request that never returns headers and does not retry after the deadline', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        }),
    );
    const pending = expect(servedManifest(options, runtimeVersion, fetchImpl)).rejects.toThrow(
      'timed out after 30 seconds',
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([200, 400])('keeps the same deadline while reading a stalled %s response body', async (status) => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      await new Promise((done) => setTimeout(done, 20_000));
      return new Response(
        new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true });
          },
        }),
        { status },
      );
    });
    const pending = expect(servedManifest(options, runtimeVersion, fetchImpl)).rejects.toThrow(
      'timed out after 30 seconds',
    );
    await vi.advanceTimersByTimeAsync(29_999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels retry backoff at the deadline', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      await new Promise((done) => setTimeout(done, 29_900));
      return new Response('', { status: 503, headers: { 'Retry-After': '10' } });
    });
    const pending = expect(servedManifest(options, runtimeVersion, fetchImpl)).rejects.toThrow(
      'timed out after 30 seconds',
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the deadline after a successful anonymous manifest read', async () => {
    vi.useFakeTimers();
    const manifest = { launchAsset: { hash: 'expected' } };
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(manifest)));
    await expect(servedManifest(options, runtimeVersion, fetchImpl)).resolves.toEqual(manifest);
    const requestInit = fetchImpl.mock.calls[0][1];
    expect(requestInit?.signal).toBeInstanceOf(AbortSignal);
    expect(requestInit?.headers).not.toHaveProperty('EAS-Client-ID');
    expect(vi.getTimerCount()).toBe(0);
  });
});
