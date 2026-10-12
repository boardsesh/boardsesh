import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../db/client';
import { logger } from '../utils/logger';
import type { PgBoss } from 'pg-boss';
import { POSTHOG_PERSON_DELETION_QUEUE } from '@boardsesh/db/job-queue-schema';
import {
  PosthogPersonDeletionRetryableError,
  SPLIT_PERSON_QUERY,
  deletePosthogPerson,
  enqueuePosthogPersonDeletion,
  startPosthogPersonDeletion,
} from '../services/analytics/posthog-person-deletion';

/**
 * The PostHog erasure job's HTTP contract (docs/analytics-consent.md,
 * "Erasure"), with the HTTP calls mocked. The enqueue side and the worker,
 * against a running pg-boss, are in posthog-person-deletion-enqueue.test.ts.
 */

const DISTINCT_ID = '6f7f2f39-6c4c-4d4e-9a49-3b3f6a1c2d10';
const job = { distinctId: DISTINCT_ID, reason: 'account_deleted' as const, pass: 'first' as const };

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

type Reply = Response | Error;

/** PostHog's documented 202 for a queued deletion (OpenAPI `PersonBulkDeleteResponse`). */
const queuedDeletion = (personsFound = 1) => ({
  persons_found: personsFound,
  persons_deleted: 0,
  persons_queued_for_deletion: personsFound,
  events_queued_for_deletion: true,
  recordings_queued_for_deletion: true,
  deletion_errors: [],
});

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

/**
 * A PostHog stand-in: the HogQL lookup (`/query/`) answers `lookup`, the delete
 * (`/persons/bulk_delete/`) answers `deletion`. A fresh Response per call.
 */
function mockPosthog({
  lookup = () => jsonResponse(200, { results: [] }),
  deletion = () => jsonResponse(202, queuedDeletion()),
}: { lookup?: () => Reply; deletion?: () => Reply } = {}) {
  return vi.fn<typeof fetch>(async (input) => {
    const reply = requestUrl(input).endsWith('/query/') ? lookup() : deletion();
    if (reply instanceof Error) throw reply;
    return reply;
  });
}

function callTo(fetchImpl: ReturnType<typeof mockPosthog>, pathSuffix: string) {
  const call = fetchImpl.mock.calls.find(([input]) => requestUrl(input).endsWith(pathSuffix));
  if (!call) throw new Error(`no call to ${pathSuffix}`);
  const [input, init] = call;
  const body = typeof init?.body === 'string' ? init.body : 'null';
  return { url: requestUrl(input), init, body: JSON.parse(body) as Record<string, unknown> };
}

async function createAccount(): Promise<string> {
  const userId = randomUUID();
  await db.insert(dbSchema.users).values({ id: userId, email: `${userId}@example.invalid` });
  return userId;
}

describe('deletePosthogPerson', () => {
  beforeEach(() => {
    vi.stubEnv('POSTHOG_ENVIRONMENT', 'production');
    vi.stubEnv('POSTHOG_ERASURE_API_KEY', 'phx_test_key');
    vi.stubEnv('POSTHOG_PROJECT_ID', '999');
    vi.stubEnv('POSTHOG_API_HOST', 'https://eu.posthog.com/');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('asks PostHog to delete the person, its events and its recordings by distinct id', async () => {
    const fetchImpl = mockPosthog();

    await expect(deletePosthogPerson(job, { fetchImpl })).resolves.toBe('deleted');

    const deletion = callTo(fetchImpl, '/persons/bulk_delete/');
    expect(deletion.url).toBe('https://eu.posthog.com/api/projects/999/persons/bulk_delete/');
    expect(deletion.init?.method).toBe('POST');
    expect(deletion.init?.headers).toMatchObject({
      Authorization: 'Bearer phx_test_key',
      'Content-Type': 'application/json',
    });
    expect(deletion.body).toEqual({ distinct_ids: [DISTINCT_ID], delete_events: true, delete_recordings: true });
  });

  it('reads the dedicated erasure key, never the shared read-only personal key', async () => {
    vi.stubEnv('POSTHOG_ERASURE_API_KEY', '');
    vi.stubEnv('POSTHOG_PERSONAL_API_KEY', 'phx_read_only');
    const fetchImpl = mockPosthog();

    await expect(deletePosthogPerson(job, { fetchImpl })).rejects.toBeInstanceOf(PosthogPersonDeletionRetryableError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('looks up the anonymous ids the account signed in from with one HogQL query', async () => {
    const fetchImpl = mockPosthog();

    await deletePosthogPerson(job, { fetchImpl });

    const lookup = callTo(fetchImpl, '/query/');
    expect(lookup.url).toBe('https://eu.posthog.com/api/projects/999/query/');
    expect(lookup.init?.headers).toMatchObject({ Authorization: 'Bearer phx_test_key' });
    expect(lookup.body).toEqual({
      query: { kind: 'HogQLQuery', query: SPLIT_PERSON_QUERY, values: { account_id: DISTINCT_ID } },
    });
    expect(SPLIT_PERSON_QUERY).toContain("event = '$identify'");
    expect(SPLIT_PERSON_QUERY).toContain('distinct_id = {account_id}');
    expect(SPLIT_PERSON_QUERY).toContain('LIMIT 999');
    // The lookup comes first, so the delete can include what it found.
    expect(requestUrl(fetchImpl.mock.calls[0][0])).toMatch(/\/query\/$/);
  });

  it('deletes split persons too: anonymous ids only this account (or a pre-#6078 party id) signed in from', async () => {
    const partyUuid = randomUUID();
    const fetchImpl = mockPosthog({
      lookup: () =>
        jsonResponse(200, {
          results: [
            ['sdk-anon-merged', [DISTINCT_ID]],
            // Identified to the install's party UUID first, then the account: PostHog refused the merge.
            ['sdk-anon-split', [partyUuid, DISTINCT_ID]],
            // Never an anonymous id worth sending.
            ['', [DISTINCT_ID]],
            [DISTINCT_ID, [DISTINCT_ID]],
            [null, [DISTINCT_ID]],
          ],
        }),
    });

    await expect(deletePosthogPerson(job, { fetchImpl })).resolves.toBe('deleted');

    expect(callTo(fetchImpl, '/persons/bulk_delete/').body.distinct_ids).toEqual([
      DISTINCT_ID,
      'sdk-anon-merged',
      'sdk-anon-split',
    ]);
  });

  it('skips an anonymous id another account also signed in from (a shared phone)', async () => {
    const otherAccount = await createAccount();
    const anonymousAccountId = await createAccount();
    const fetchImpl = mockPosthog({
      lookup: () =>
        jsonResponse(200, {
          results: [
            ['sdk-anon-shared', [DISTINCT_ID, otherAccount]],
            // An account id used as the anonymous id (switching accounts without a reset).
            [anonymousAccountId, [DISTINCT_ID]],
            ['sdk-anon-own', [DISTINCT_ID]],
          ],
        }),
    });

    await deletePosthogPerson(job, { fetchImpl });

    expect(callTo(fetchImpl, '/persons/bulk_delete/').body.distinct_ids).toEqual([DISTINCT_ID, 'sdk-anon-own']);
  });

  it.each([200, 202])('accepts a %i with the documented body as done', async (status) => {
    const fetchImpl = mockPosthog({ deletion: () => jsonResponse(status, queuedDeletion()) });
    await expect(deletePosthogPerson(job, { fetchImpl })).resolves.toBe('deleted');
  });

  it('accepts no matching person (a 202 with persons_found 0) as done', async () => {
    const fetchImpl = mockPosthog({ deletion: () => jsonResponse(202, queuedDeletion(0)) });
    await expect(deletePosthogPerson(job, { fetchImpl })).resolves.toBe('deleted');
  });

  it('accepts a documented body that leaves out the optional deletion_errors', async () => {
    const { deletion_errors: _omitted, ...withoutErrors } = queuedDeletion();
    const fetchImpl = mockPosthog({ deletion: () => jsonResponse(202, withoutErrors) });
    await expect(deletePosthogPerson(job, { fetchImpl })).resolves.toBe('deleted');
  });

  it.each([
    ['no body (204)', () => new Response(null, { status: 204 })],
    ['a body that is not JSON', () => new Response('<html>Bad gateway</html>', { status: 200 })],
    ['a truncated body', () => new Response('{"persons_found": 1, "persons_queued', { status: 202 })],
    ['an empty object', () => jsonResponse(202, {})],
    ['no persons_queued_for_deletion', () => jsonResponse(202, { persons_found: 1, persons_deleted: 1 })],
    ['deletion_errors that is not a list', () => jsonResponse(202, { ...queuedDeletion(), deletion_errors: 'boom' })],
    ['counts that are not counts', () => jsonResponse(202, { ...queuedDeletion(), persons_found: '1' })],
  ])('retries a 2xx with %s: it proves nothing was deleted', async (_label, deletion) => {
    const fetchImpl = mockPosthog({ deletion });
    await expect(deletePosthogPerson(job, { fetchImpl })).rejects.toBeInstanceOf(PosthogPersonDeletionRetryableError);
  });

  it('defaults to the US private API host and the Boardsesh project', async () => {
    vi.stubEnv('POSTHOG_PROJECT_ID', '');
    vi.stubEnv('POSTHOG_API_HOST', '');
    const fetchImpl = mockPosthog();

    await deletePosthogPerson(job, { fetchImpl });

    expect(callTo(fetchImpl, '/persons/bulk_delete/').url).toBe(
      'https://us.posthog.com/api/projects/412845/persons/bulk_delete/',
    );
    expect(callTo(fetchImpl, '/query/').url).toBe('https://us.posthog.com/api/projects/412845/query/');
  });

  it('retries a 404 from the delete and logs the URL at error: the project id or host is wrong', async () => {
    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const fetchImpl = mockPosthog({ deletion: () => jsonResponse(404, { detail: 'Not found.' }) });

    await expect(deletePosthogPerson(job, { fetchImpl })).rejects.toBeInstanceOf(PosthogPersonDeletionRetryableError);

    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('will retry'),
      expect.objectContaining({
        status: 404,
        url: 'https://eu.posthog.com/api/projects/999/persons/bulk_delete/',
      }),
    );
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('phx_test_key');
    errorLog.mockRestore();
  });

  it.each([500, 502, 503, 429, 408, 401, 403, 404])(
    'throws on a %i from the delete so pg-boss retries',
    async (status) => {
      const fetchImpl = mockPosthog({ deletion: () => jsonResponse(status) });
      await expect(deletePosthogPerson(job, { fetchImpl })).rejects.toBeInstanceOf(PosthogPersonDeletionRetryableError);
    },
  );

  it.each([500, 429, 403, 404])('throws on a %i from the lookup, before deleting anything', async (status) => {
    const fetchImpl = mockPosthog({ lookup: () => jsonResponse(status) });
    await expect(deletePosthogPerson(job, { fetchImpl })).rejects.toBeInstanceOf(PosthogPersonDeletionRetryableError);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('throws on a network failure so pg-boss retries', async () => {
    const fetchImpl = mockPosthog({ deletion: () => new TypeError('fetch failed') });
    await expect(deletePosthogPerson(job, { fetchImpl })).rejects.toBeInstanceOf(PosthogPersonDeletionRetryableError);
  });

  it('retries when the lookup answer is not a result set', async () => {
    const fetchImpl = mockPosthog({ lookup: () => jsonResponse(200, { error: 'timeout' }) });
    await expect(deletePosthogPerson(job, { fetchImpl })).rejects.toBeInstanceOf(PosthogPersonDeletionRetryableError);
  });

  it('retries when PostHog reports a partial deletion', async () => {
    const fetchImpl = mockPosthog({
      deletion: () =>
        jsonResponse(202, { ...queuedDeletion(), deletion_errors: [{ person_uuid: 'x', step: 'events' }] }),
    });
    await expect(deletePosthogPerson(job, { fetchImpl })).rejects.toBeInstanceOf(PosthogPersonDeletionRetryableError);
  });

  it('does not retry a delete PostHog rejects as malformed', async () => {
    const fetchImpl = mockPosthog({ deletion: () => jsonResponse(400) });
    await expect(deletePosthogPerson(job, { fetchImpl })).resolves.toBe('rejected');
  });

  it('still deletes the account id when the lookup is rejected, then reports the job rejected', async () => {
    const fetchImpl = mockPosthog({ lookup: () => jsonResponse(400, { detail: 'Unknown function' }) });

    await expect(deletePosthogPerson(job, { fetchImpl })).resolves.toBe('rejected');

    expect(callTo(fetchImpl, '/persons/bulk_delete/').body.distinct_ids).toEqual([DISTINCT_ID]);
  });

  it('throws without the erasure key, so a key set later still erases the person', async () => {
    vi.stubEnv('POSTHOG_ERASURE_API_KEY', '');
    const fetchImpl = mockPosthog();

    await expect(deletePosthogPerson(job, { fetchImpl })).rejects.toBeInstanceOf(PosthogPersonDeletionRetryableError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never calls PostHog outside production', async () => {
    vi.stubEnv('POSTHOG_ENVIRONMENT', 'preview');
    const fetchImpl = mockPosthog();

    await expect(deletePosthogPerson(job, { fetchImpl })).resolves.toBe('skipped_non_production');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('accepts a job replayed by hand without a pass', async () => {
    const fetchImpl = mockPosthog();
    await expect(
      deletePosthogPerson({ distinctId: DISTINCT_ID, reason: 'consent_withdrawn' }, { fetchImpl }),
    ).resolves.toBe('deleted');
  });

  it('drops a malformed job without calling PostHog', async () => {
    const fetchImpl = mockPosthog();

    await expect(deletePosthogPerson({ distinctId: '', reason: 'nope' }, { fetchImpl })).resolves.toBe('rejected');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('startPosthogPersonDeletion', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function fakeQueue() {
    const work = vi.fn(async () => 'worker-id');
    return { work, boss: { work } as unknown as PgBoss };
  }

  it('registers no worker without the erasure key, so queued jobs wait instead of spending retries', async () => {
    vi.stubEnv('POSTHOG_ENVIRONMENT', 'production');
    vi.stubEnv('POSTHOG_ERASURE_API_KEY', '');
    const { work, boss } = fakeQueue();

    await expect(startPosthogPersonDeletion(boss)).resolves.toBe(false);
    expect(work).not.toHaveBeenCalled();
  });

  it('registers no worker outside production, even with a key', async () => {
    vi.stubEnv('POSTHOG_ENVIRONMENT', 'preview');
    vi.stubEnv('POSTHOG_ERASURE_API_KEY', 'phx_test_key');
    const { work, boss } = fakeQueue();

    await expect(startPosthogPersonDeletion(boss)).resolves.toBe(false);
    expect(work).not.toHaveBeenCalled();
  });

  it('works the queue one job at a time on a production backend holding the key', async () => {
    vi.stubEnv('POSTHOG_ENVIRONMENT', 'production');
    vi.stubEnv('POSTHOG_ERASURE_API_KEY', 'phx_test_key');
    const { work, boss } = fakeQueue();

    await expect(startPosthogPersonDeletion(boss)).resolves.toBe(true);
    expect(work).toHaveBeenCalledWith(
      POSTHOG_PERSON_DELETION_QUEUE,
      expect.objectContaining({ batchSize: 1, localConcurrency: 1, includeMetadata: true, perJobResults: true }),
      expect.any(Function),
    );
  });
});

describe('enqueuePosthogPersonDeletion without a running job queue', () => {
  it('queues nothing, logs the distinct id at error for a replay, and leaves the caller transaction to commit', async () => {
    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const userId = randomUUID();
    const queued = await db.transaction(async (transaction) => {
      await transaction.insert(dbSchema.users).values({ id: userId, email: `${userId}@example.invalid` });
      return enqueuePosthogPersonDeletion(transaction, { distinctId: userId, reason: 'consent_withdrawn' });
    });

    expect(queued).toBe(false);
    const rows = await db.select().from(dbSchema.users).where(eq(dbSchema.users.id, userId));
    expect(rows).toHaveLength(1);
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('not queued'),
      expect.objectContaining({
        event: 'posthog_person_deletion_not_queued',
        distinctId: userId,
        reason: 'consent_withdrawn',
      }),
    );
    errorLog.mockRestore();
  });
});
