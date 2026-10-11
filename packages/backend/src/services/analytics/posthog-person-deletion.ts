import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { POSTHOG_PERSON_DELETION_QUEUE } from '@boardsesh/db/job-queue-schema';
import type { Database } from '../../db/client';
import { enqueueOn, getJobQueue } from '../job-queue';
import { MAINTENANCE_POLLING_INTERVAL_SECONDS } from '../job-queue-client';
import { logger } from '../../utils/logger';
import { getAnalyticsEnvironment } from './posthog';

/**
 * Erasing a climber's PostHog person (GDPR Art. 17), see
 * docs/analytics-consent.md ("Erasure").
 *
 * Both clients identify a signed-in climber with `users.id`, and `identify()`
 * merges the anonymous person the device used before sign-in into that person.
 * So deleting the person behind the account id removes the account's profile
 * (email, Apple Ads and install-referrer properties) and every distinct id
 * merged into it. PostHog removes the person record shortly after the request;
 * its events and recordings are deleted later, in a background pass of its own.
 *
 * The request runs in a pg-boss job, never inside the transaction that deletes
 * the account or records the withdrawal: the job row commits with that
 * transaction, and the HTTP call happens afterwards, with retries.
 */

export type PosthogPersonDeletionReason = 'account_deleted' | 'consent_withdrawn';

export type PosthogPersonDeletionJob = {
  /** The PostHog distinct id to erase: the account id both clients identify with. */
  distinctId: string;
  reason: PosthogPersonDeletionReason;
};

const jobSchema = z.object({
  distinctId: z.string().min(1).max(200),
  reason: z.enum(['account_deleted', 'consent_withdrawn']),
});

/** A drizzle transaction on the backend's primary pool. */
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Queue the erasure inside the caller's transaction, so it exists exactly when
 * the deletion or withdrawal commits. Never throws and never aborts the caller:
 * the send runs in a savepoint, so a failure (queue not started, queue missing)
 * rolls back only the job and leaves a warning. Returns whether a job was queued.
 */
export async function enqueuePosthogPersonDeletion(
  transaction: Transaction,
  job: PosthogPersonDeletionJob,
): Promise<boolean> {
  const boss = getJobQueue();
  if (!boss) {
    logger.warn('[PostHogErasure] Job queue not running; PostHog person deletion not queued', {
      event: 'posthog_person_deletion_not_queued',
      reason: job.reason,
    });
    return false;
  }
  try {
    const jobId = await transaction.transaction((savepoint) =>
      boss.send(POSTHOG_PERSON_DELETION_QUEUE, job, { db: enqueueOn(savepoint) }),
    );
    if (!jobId) throw new Error('POSTHOG_PERSON_DELETION_NOT_QUEUED');
    return true;
  } catch (error) {
    logger.warn('[PostHogErasure] Could not queue PostHog person deletion', {
      event: 'posthog_person_deletion_not_queued',
      reason: job.reason,
      error,
    });
    return false;
  }
}

const DEFAULT_POSTHOG_PROJECT_ID = '412845';
/** The private API host. Not the ingestion host (`us.i.posthog.com`) the capture client uses. */
const DEFAULT_POSTHOG_API_HOST = 'https://us.posthog.com';
const REQUEST_TIMEOUT_MS = 30_000;

type PosthogPrivateApiConfig = { apiKey: string; projectId: string; host: string };

function readEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function readPrivateApiConfig(): PosthogPrivateApiConfig | null {
  const apiKey = readEnv('POSTHOG_PERSONAL_API_KEY');
  if (!apiKey) return null;
  return {
    apiKey,
    projectId: readEnv('POSTHOG_PROJECT_ID') ?? DEFAULT_POSTHOG_PROJECT_ID,
    host: (readEnv('POSTHOG_API_HOST') ?? DEFAULT_POSTHOG_API_HOST).replace(/\/+$/, ''),
  };
}

const bulkDeleteResponseSchema = z
  .object({
    persons_found: z.number().optional(),
    persons_queued_for_deletion: z.number().optional(),
    deletion_errors: z.array(z.unknown()).optional(),
  })
  .passthrough();

/** Thrown for an outcome a retry can fix; pg-boss schedules the next attempt. */
export class PosthogPersonDeletionRetryableError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'PosthogPersonDeletionRetryableError';
  }
}

export type PosthogPersonDeletionOutcome = 'deleted' | 'not_found' | 'skipped_non_production' | 'rejected';

export type DeletePosthogPersonOptions = {
  fetchImpl?: typeof fetch;
};

/**
 * One erasure attempt: `POST /api/projects/:id/persons/bulk_delete/` with the
 * account's distinct id, events and recordings included.
 *
 * - 2xx: done. A non-empty `deletion_errors` throws so the job retries.
 * - 404: nothing to delete. Done.
 * - 401, 403, 408, 429, 5xx, a timeout or a network error: throws. A key can
 *   be fixed and an outage ends, so pg-boss retries with backoff.
 * - Any other 4xx: the request itself is wrong and a retry would send it
 *   again. Logged as an error, done.
 *
 * Only production calls PostHog, the same gate as backend capture: a dev or
 * preview backend must never delete a person in the production project.
 */
export async function deletePosthogPerson(
  payload: unknown,
  { fetchImpl = fetch }: DeletePosthogPersonOptions = {},
): Promise<PosthogPersonDeletionOutcome> {
  const parsed = jobSchema.safeParse(payload);
  if (!parsed.success) {
    logger.error('[PostHogErasure] Dropped a malformed person deletion job', {
      event: 'posthog_person_deletion_invalid_job',
    });
    return 'rejected';
  }
  const { distinctId, reason } = parsed.data;

  const environment = getAnalyticsEnvironment();
  if (environment !== 'production') {
    logger.info('[PostHogErasure] Not production; PostHog person deletion skipped', {
      event: 'posthog_person_deletion_skipped',
      environment,
      reason,
    });
    return 'skipped_non_production';
  }

  const config = readPrivateApiConfig();
  if (!config) {
    logger.error('[PostHogErasure] POSTHOG_PERSONAL_API_KEY is not set; PostHog person deletion will retry', {
      event: 'posthog_person_deletion_unconfigured',
      reason,
    });
    throw new PosthogPersonDeletionRetryableError('POSTHOG_PERSONAL_API_KEY is not set');
  }

  const url = `${config.host}/api/projects/${encodeURIComponent(config.projectId)}/persons/bulk_delete/`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ distinct_ids: [distinctId], delete_events: true, delete_recordings: true }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    logger.warn('[PostHogErasure] PostHog person deletion request failed; will retry', {
      event: 'posthog_person_deletion_retry',
      reason,
      error,
    });
    throw new PosthogPersonDeletionRetryableError('PostHog person deletion request failed');
  }

  const { status } = response;
  if (status >= 200 && status < 300) {
    const body = bulkDeleteResponseSchema.safeParse(await response.json().catch(() => ({})));
    const result = body.success ? body.data : {};
    if (result.deletion_errors && result.deletion_errors.length > 0) {
      logger.warn('[PostHogErasure] PostHog reported an incomplete person deletion; will retry', {
        event: 'posthog_person_deletion_retry',
        reason,
        status,
        deletionErrors: result.deletion_errors.length,
      });
      throw new PosthogPersonDeletionRetryableError('PostHog reported deletion_errors', status);
    }
    logger.info('[PostHogErasure] PostHog person deletion accepted', {
      event: 'posthog_person_deletion_accepted',
      reason,
      status,
      personsFound: result.persons_found,
      personsQueuedForDeletion: result.persons_queued_for_deletion,
    });
    return 'deleted';
  }
  if (status === 404) {
    logger.info('[PostHogErasure] PostHog has no person to delete', {
      event: 'posthog_person_deletion_not_found',
      reason,
    });
    return 'not_found';
  }
  if (status === 401 || status === 403 || status === 408 || status === 429 || status >= 500) {
    const level = status === 401 || status === 403 ? 'error' : 'warn';
    logger[level]('[PostHogErasure] PostHog person deletion refused; will retry', {
      event: 'posthog_person_deletion_retry',
      reason,
      status,
    });
    throw new PosthogPersonDeletionRetryableError(`PostHog person deletion returned ${status}`, status);
  }
  logger.error('[PostHogErasure] PostHog rejected the person deletion request; not retrying', {
    event: 'posthog_person_deletion_rejected',
    reason,
    status,
  });
  return 'rejected';
}

/** Work the erasure queue on this replica. The migrator creates the queue. */
export async function startPosthogPersonDeletion(boss: PgBoss): Promise<void> {
  await boss.work<PosthogPersonDeletionJob>(
    POSTHOG_PERSON_DELETION_QUEUE,
    { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds: MAINTENANCE_POLLING_INTERVAL_SECONDS },
    async (jobs) => {
      for (const job of jobs) await deletePosthogPerson(job.data);
    },
  );
}
