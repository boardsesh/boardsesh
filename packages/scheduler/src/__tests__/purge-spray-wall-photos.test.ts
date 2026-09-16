import { afterEach, describe, expect, it, vi } from 'vitest';
import { purgeSprayWallPhotos, PURGE_SPRAY_WALL_PHOTOS_MUTATION } from '../jobs/purge-spray-wall-photos';
import { loadSchedulerConfig } from '../config';

/**
 * The scheduler half of the 30-day photo retention (SW-17).
 *
 * What is testable here is the HTTP contract, not the deletion: the work runs in
 * the backend, which owns the database and the storage credentials. So this pins
 * the three things a job can get wrong on its own — posting the cron credentials,
 * refusing a 200 that carries GraphQL errors, and not retrying a status that
 * means "the server said no" rather than "the server was not there".
 *
 * The threshold itself — deleted 31 days ago goes, deleted yesterday stays — is
 * asserted against a real database in
 * `packages/backend/src/__tests__/spray-wall-moderation.test.ts`.
 */

const result = { wallsPurged: 3, objectsDeleted: 7, wallsConsidered: 3, durationMs: 412 };
const context = {
  config: loadSchedulerConfig({
    CRON_SECRET: 'test-secret',
    BOARDSESH_BACKEND_GRAPHQL_URL: 'https://backend.test/graphql',
  }),
  timeoutMs: 60_000,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
};
const success = () => new Response(JSON.stringify({ data: { purgeDeletedSprayWallPhotos: result } }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('spray wall photo purge scheduler job', () => {
  it('posts the mutation and cron credentials directly to the backend', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(success());
    expect(await purgeSprayWallPhotos(context)).toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://backend.test/graphql',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-secret', 'Content-Type': 'application/json' }),
        body: JSON.stringify({ query: PURGE_SPRAY_WALL_PHOTOS_MUTATION }),
      }),
    );
  });

  it('refuses a 200 that carries GraphQL errors', async () => {
    // The failure this exists for: a resolver error comes back inside a 200, so a
    // job that only checked the status would report a successful purge on a run
    // that deleted nothing, and a monitor would go on saying the retention window
    // is being honoured.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ errors: [{ message: 'nope' }], data: null })),
    );
    await expect(purgeSprayWallPhotos(context)).rejects.toThrow('GraphQL errors');
  });

  it('refuses a result missing a count', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { purgeDeletedSprayWallPhotos: { wallsPurged: 1 } } })),
    );
    await expect(purgeSprayWallPhotos(context)).rejects.toThrow('invalid result');
  });

  it.each([401, 409, 500, 504])('fails without retrying HTTP %s', async (status) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('unavailable', { status }));
    await expect(purgeSprayWallPhotos(context)).rejects.toThrow(`HTTP ${status}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([502, 503])('retries HTTP %s once — a deploy in flight is not a failed purge', async (status) => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('unavailable', { status }))
      .mockResolvedValueOnce(success());
    expect(await purgeSprayWallPhotos(context)).toEqual(result);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
