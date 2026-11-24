import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GymMcpPrincipal } from '../auth';

const fixtures = vi.hoisted(() => ({
  fetch: vi.fn(),
  resolveGym: vi.fn(),
  encode: vi.fn(),
  store: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('../../../auth/partner/secure-resource-fetch', () => ({ fetchPublicHttpsResource: fixtures.fetch }));
vi.mock('../domain', () => ({ resolveGymForTool: fixtures.resolveGym }));
vi.mock('../../../lib/image-resize', () => ({ reencodeUploadedImage: fixtures.encode }));
vi.mock('../../../services/gym-image-storage', () => ({
  storeVersionedGymImage: fixtures.store,
  removeVersionedGymImage: fixtures.remove,
}));

import { prepareGymMcpImage } from '../media';

const gymUuid = '11111111-1111-4111-8111-111111111111';
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const storedUrl = `/static/gym-photos/${gymUuid}.22222222-2222-4222-8222-222222222222.png`;
const principal: GymMcpPrincipal = {
  clientId: 'assistant',
  userId: 'owner',
  connectionId: 'connection',
  connectionGeneration: 1,
  scopes: ['gyms:read', 'gyms:write'],
  accessTokenHash: 'test-hash',
  connectionLastUsedAt: null,
};
function imageResponse() {
  return new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png' } });
}
function deferred<Result>() {
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}
function prepare(connectionId = principal.connectionId, signal?: AbortSignal) {
  return prepareGymMcpImage(
    { ...principal, connectionId },
    gymUuid,
    'photo',
    'https://images.example/photo.png',
    signal,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  fixtures.fetch.mockImplementation(async () => imageResponse());
  fixtures.resolveGym.mockResolvedValue({ uuid: gymUuid });
  fixtures.encode.mockResolvedValue(png);
  fixtures.store.mockResolvedValue(storedUrl);
  fixtures.remove.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

describe('gym MCP image preparation admission', () => {
  it('reserves one preparation per connection before authorization and retains the two-connection global cap', async () => {
    const authorized = deferred<{ uuid: string }>();
    fixtures.resolveGym.mockReturnValue(authorized.promise);
    const first = prepare();
    const second = prepare('other-connection');
    try {
      await expect(prepare()).rejects.toMatchObject({ extensions: { code: 'RATE_LIMITED' } });
      await expect(prepare('third-connection')).rejects.toMatchObject({ extensions: { code: 'RATE_LIMITED' } });
      expect(fixtures.resolveGym).toHaveBeenCalledTimes(2);
      authorized.resolve({ uuid: gymUuid });
      await Promise.all([first, second]);
      await expect(prepare('third-connection')).resolves.toMatchObject({ storedUrl });
    } finally {
      authorized.resolve({ uuid: gymUuid });
      await Promise.allSettled([first, second]);
    }
  });

  it.each(['authorization', 'fetch', 'decode', 'storage'])(
    'releases the connection and global permits after %s failure',
    async (stage) => {
      const failed =
        stage === 'authorization'
          ? fixtures.resolveGym
          : stage === 'fetch'
            ? fixtures.fetch
            : stage === 'decode'
              ? fixtures.encode
              : fixtures.store;
      failed.mockRejectedValueOnce(new Error(`${stage} unavailable`));
      await expect(prepare()).rejects.toBeDefined();
      await expect(prepare()).resolves.toMatchObject({ storedUrl });
    },
  );

  it('releases preparation capacity at the fetch deadline even when the DNS transport ignores abort', async () => {
    vi.useFakeTimers();
    const blocked = deferred<Response>();
    fixtures.fetch.mockReturnValueOnce(blocked.promise);
    const refused = expect(prepare()).rejects.toThrow('could not be fetched');
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      await refused;
      await expect(prepare()).resolves.toMatchObject({ storedUrl });
    } finally {
      blocked.resolve(imageResponse());
      await refused;
    }
  });

  it('cancels a blocked image fetch and releases its connection for another preparation', async () => {
    const blocked = deferred<Response>();
    const cancellation = new AbortController();
    fixtures.fetch.mockReturnValueOnce(blocked.promise);
    const refused = expect(prepare(undefined, cancellation.signal)).rejects.toMatchObject({
      extensions: { code: 'CANCELLED' },
    });
    try {
      await vi.waitFor(() => expect(fixtures.fetch).toHaveBeenCalledOnce());
      cancellation.abort();
      await refused;
      const fetchOptions = fixtures.fetch.mock.calls[0]?.[1] as RequestInit | undefined;
      expect(fetchOptions?.signal?.aborted).toBe(true);
      await expect(prepare()).resolves.toMatchObject({ storedUrl });
    } finally {
      cancellation.abort();
      blocked.resolve(imageResponse());
      await refused;
    }
  });

  it('keeps storage in flight bounded and discards a staged upload if cancellation arrives during storage', async () => {
    const uploaded = deferred<string>();
    const cancellation = new AbortController();
    fixtures.store.mockReturnValueOnce(uploaded.promise);
    const refused = expect(prepare(undefined, cancellation.signal)).rejects.toMatchObject({
      extensions: { code: 'CANCELLED' },
    });
    try {
      await vi.waitFor(() => expect(fixtures.store).toHaveBeenCalledOnce());
      cancellation.abort();
      await expect(prepare()).rejects.toMatchObject({ extensions: { code: 'RATE_LIMITED' } });
      uploaded.resolve(storedUrl);
      await refused;
      expect(fixtures.remove).toHaveBeenCalledWith(gymUuid, 'photo', storedUrl);
      await expect(prepare()).resolves.toMatchObject({ storedUrl });
    } finally {
      uploaded.resolve(storedUrl);
      await refused;
    }
  });
});
