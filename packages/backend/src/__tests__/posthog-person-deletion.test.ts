import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../db/client';
import {
  PosthogPersonDeletionRetryableError,
  deletePosthogPerson,
  enqueuePosthogPersonDeletion,
} from '../services/analytics/posthog-person-deletion';

/**
 * The PostHog erasure job's HTTP contract (docs/analytics-consent.md,
 * "Erasure"), with the HTTP call mocked. The enqueue side, against a running
 * pg-boss, is in posthog-person-deletion-enqueue.test.ts.
 */

const DISTINCT_ID = '6f7f2f39-6c4c-4d4e-9a49-3b3f6a1c2d10';
const job = { distinctId: DISTINCT_ID, reason: 'account_deleted' as const };

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function mockFetch(response: Response | Error) {
  return vi.fn<typeof fetch>(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
}

describe('deletePosthogPerson', () => {
  beforeEach(() => {
    vi.stubEnv('POSTHOG_ENVIRONMENT', 'production');
    vi.stubEnv('POSTHOG_PERSONAL_API_KEY', 'phx_test_key');
    vi.stubEnv('POSTHOG_PROJECT_ID', '999');
    vi.stubEnv('POSTHOG_API_HOST', 'https://eu.posthog.com/');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('asks PostHog to delete the person, its events and its recordings by distinct id', async () => {
    const fetchImpl = mockFetch(jsonResponse(202, { persons_found: 1, persons_queued_for_deletion: 1 }));

    await expect(deletePosthogPerson(job, { fetchImpl })).resolves.toBe('deleted');

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://eu.posthog.com/api/projects/999/persons/bulk_delete/');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer phx_test_key', 'Content-Type': 'application/json' });
    expect(JSON.parse(init?.body as string)).toEqual({
      distinct_ids: [DISTINCT_ID],
      delete_events: true,
      delete_recordings: true,
    });
  });

  it('defaults to the US private API host and the Boardsesh project', async () => {
    vi.stubEnv('POSTHOG_PROJECT_ID', '');
    vi.stubEnv('POSTHOG_API_HOST', '');
    const fetchImpl = mockFetch(jsonResponse(202));

    await deletePosthogPerson(job, { fetchImpl });

    expect(fetchImpl.mock.calls[0][0]).toBe('https://us.posthog.com/api/projects/412845/persons/bulk_delete/');
  });

  it('treats a 404 as nothing left to delete', async () => {
    await expect(deletePosthogPerson(job, { fetchImpl: mockFetch(jsonResponse(404)) })).resolves.toBe('not_found');
  });

  it.each([500, 502, 503, 429, 408, 401, 403])('throws on %i so pg-boss retries', async (status) => {
    await expect(deletePosthogPerson(job, { fetchImpl: mockFetch(jsonResponse(status)) })).rejects.toBeInstanceOf(
      PosthogPersonDeletionRetryableError,
    );
  });

  it('throws on a network failure so pg-boss retries', async () => {
    await expect(
      deletePosthogPerson(job, { fetchImpl: mockFetch(new TypeError('fetch failed')) }),
    ).rejects.toBeInstanceOf(PosthogPersonDeletionRetryableError);
  });

  it('retries when PostHog reports a partial deletion', async () => {
    const fetchImpl = mockFetch(
      jsonResponse(202, { persons_found: 1, deletion_errors: [{ person_uuid: 'x', step: 'events' }] }),
    );
    await expect(deletePosthogPerson(job, { fetchImpl })).rejects.toBeInstanceOf(PosthogPersonDeletionRetryableError);
  });

  it('does not retry a request PostHog rejects as malformed', async () => {
    await expect(deletePosthogPerson(job, { fetchImpl: mockFetch(jsonResponse(400)) })).resolves.toBe('rejected');
  });

  it('throws without a personal API key, so a key set later still erases the person', async () => {
    vi.stubEnv('POSTHOG_PERSONAL_API_KEY', '');
    const fetchImpl = mockFetch(jsonResponse(202));

    await expect(deletePosthogPerson(job, { fetchImpl })).rejects.toBeInstanceOf(PosthogPersonDeletionRetryableError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never calls PostHog outside production', async () => {
    vi.stubEnv('POSTHOG_ENVIRONMENT', 'preview');
    const fetchImpl = mockFetch(jsonResponse(202));

    await expect(deletePosthogPerson(job, { fetchImpl })).resolves.toBe('skipped_non_production');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('drops a malformed job without calling PostHog', async () => {
    const fetchImpl = mockFetch(jsonResponse(202));

    await expect(deletePosthogPerson({ distinctId: '', reason: 'nope' }, { fetchImpl })).resolves.toBe('rejected');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('enqueuePosthogPersonDeletion without a running job queue', () => {
  it('queues nothing and leaves the caller transaction to commit', async () => {
    const userId = randomUUID();
    const queued = await db.transaction(async (transaction) => {
      await transaction.insert(dbSchema.users).values({ id: userId, email: `${userId}@example.invalid` });
      return enqueuePosthogPersonDeletion(transaction, { distinctId: userId, reason: 'consent_withdrawn' });
    });

    expect(queued).toBe(false);
    const rows = await db.select().from(dbSchema.users).where(eq(dbSchema.users.id, userId));
    expect(rows).toHaveLength(1);
  });
});
