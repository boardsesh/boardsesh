import type { JobResult, JobWithMetadata, PgBoss } from 'pg-boss';
import { DrizzleQueryError, inArray } from 'drizzle-orm';
import { z } from 'zod';
import * as dbSchema from '@boardsesh/db/schema';
import { POSTHOG_PERSON_DELETION_QUEUE } from '@boardsesh/db/job-queue-schema';
import { db, type Database } from '../../db/client';
import { enqueueOn, getJobQueue, requireJobQueue } from '../job-queue';
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
 * merged into it. Where PostHog refused that merge (a "split person", see
 * docs/growth-metrics.md, "Identity-split pitfall"), the pre-sign-in person is
 * found through the account's `$identify` events and deleted with it.
 *
 * Each pass runs in two steps, because the delete erases the `$identify`
 * events the lookup reads:
 *
 * 1. **Discover** (a job without `stage`): look up the anonymous ids, then, in
 *    one transaction, write them into every erasure of this account still
 *    waiting (the late pass) and queue this pass's `delete` step carrying them.
 *    A failed lookup deletes nothing and retries.
 * 2. **Delete** (`stage: 'delete'`): `bulk_delete` the account id and the
 *    persisted ids. Its retries reuse them.
 *
 * The requests run in pg-boss jobs, never inside the transaction that deletes
 * the account or records the withdrawal: the job rows commit with that
 * transaction, and the HTTP calls happen afterwards, with retries.
 */

export type PosthogPersonDeletionReason = 'account_deleted' | 'consent_withdrawn';

/**
 * `first` runs {@link FIRST_PASS_DELAY_SECONDS} after the commit; `late` runs
 * {@link LATE_PASS_DELAY_SECONDS} after it, for events that reach PostHog after
 * the first pass (PostHog deletes only events captured before the request).
 * A job replayed by hand may leave it out.
 */
export type PosthogPersonDeletionPass = 'first' | 'late';

export type PosthogPersonDeletionJob = {
  /** The PostHog distinct id to erase: the account id both clients identify with. */
  distinctId: string;
  reason: PosthogPersonDeletionReason;
  pass?: PosthogPersonDeletionPass;
  /**
   * Anonymous ids already discovered for this account (shared-phone ids
   * excluded), persisted before any delete so a later step or pass can still
   * erase them once their `$identify` events are gone.
   */
  anonymousIds?: string[];
  /** `delete`: discovery is done, delete `distinctId` and `anonymousIds`. Absent: discover first. */
  stage?: 'delete';
};

/**
 * Long enough for a device's on-disk event queue to flush on its next
 * foreground and for ingestion to catch up, short enough that the person is
 * gone the same hour.
 */
export const FIRST_PASS_DELAY_SECONDS = 15 * 60;
/**
 * Catches what the first pass could not: another signed-in device that had
 * not yet re-read the account's denial (or hit a 401 after deletion), and a
 * phone that stayed offline for days with events queued.
 */
export const LATE_PASS_DELAY_SECONDS = 7 * 24 * 60 * 60;

const PASSES: ReadonlyArray<readonly [PosthogPersonDeletionPass, number]> = [
  ['first', FIRST_PASS_DELAY_SECONDS],
  ['late', LATE_PASS_DELAY_SECONDS],
];

/** `bulk_delete` takes at most 1000 distinct ids; one is the account's. */
const MAX_ANONYMOUS_IDS = 999;
/** Far above any id our SDKs mint (a 36-character UUID), and the most a job carries. */
const MAX_DISTINCT_ID_LENGTH = 200;
/**
 * More distinct ids than this signed in from one anonymous id means it is no one
 * climber's device (a kiosk, or ids sent with the public key): skipped like a
 * shared phone. It also caps one discovery's account check near 101,000 ids.
 */
const MAX_IDENTIFIED_AS_PER_ANONYMOUS_ID = 100;
/** Ids per `users` query: postgres.js refuses a query with 65,534 parameters. */
const ACCOUNT_LOOKUP_CHUNK_SIZE = 1000;

/**
 * A character no SDK puts in a distinct id: a control character (PostgreSQL
 * cannot store a NUL in text or jsonb) or half of a surrogate pair (jsonb
 * refuses it). Matching control characters is the point of the pattern, hence
 * the disable.
 */
const UNSTORABLE_CHARACTER =
  // oxlint-disable-next-line no-control-regex
  /[\u0000-\u001F\u007F]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const UNSTORABLE_CHARACTERS = new RegExp(UNSTORABLE_CHARACTER.source, 'g');

/**
 * `distinctId`, `reason`, `pass` and `stage` must be exact: without them the job
 * cannot say whose person to erase, or how. `anonymousIds` is checked id by id
 * instead ({@link sanitizeAnonymousIds}): the lookup reads them from events
 * anyone holding the public project key can send, and one bad id must never
 * stop the account's own person from being erased.
 */
const jobSchema = z.object({
  distinctId: z.string().min(1).max(MAX_DISTINCT_ID_LENGTH),
  reason: z.enum(['account_deleted', 'consent_withdrawn']),
  pass: z.enum(['first', 'late']).optional(),
  anonymousIds: z.unknown().optional(),
  stage: z.literal('delete').optional(),
});

/** 1 to {@link MAX_DISTINCT_ID_LENGTH} characters, none of them {@link UNSTORABLE_CHARACTER}. */
function isUsableDistinctId(id: unknown): id is string {
  return (
    typeof id === 'string' && id.length > 0 && id.length <= MAX_DISTINCT_ID_LENGTH && !UNSTORABLE_CHARACTER.test(id)
  );
}

/**
 * The ids a job may send: {@link isUsableDistinctId}, deduplicated, at most
 * {@link MAX_ANONYMOUS_IDS}. `dropped` counts the rest, for a log line that
 * never carries them.
 */
function sanitizeAnonymousIds(raw: unknown): { ids: string[]; dropped: number } {
  if (raw === undefined) return { ids: [], dropped: 0 };
  if (!Array.isArray(raw)) return { ids: [], dropped: 1 };
  const ids = [...new Set(raw.filter(isUsableDistinctId))].slice(0, MAX_ANONYMOUS_IDS);
  return { ids, dropped: raw.length - ids.length };
}

/** A drizzle transaction on the backend's primary pool. */
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Queue both passes of the erasure inside the caller's transaction, so they
 * exist exactly when the deletion or withdrawal commits. Never throws and never
 * aborts the caller: the sends run in one savepoint, so a failure (queue not
 * started, queue missing) rolls back only the jobs. Returns whether they were
 * queued.
 *
 * A missed enqueue is logged at error level WITH the distinct id: once
 * `deleteAccount` commits, nothing else records whose person to erase. The log
 * line is what an operator replays from (docs/analytics-consent.md, "Erasure").
 */
export async function enqueuePosthogPersonDeletion(
  transaction: Transaction,
  { distinctId, reason }: Pick<PosthogPersonDeletionJob, 'distinctId' | 'reason'>,
): Promise<boolean> {
  const boss = getJobQueue();
  if (!boss) {
    logger.error('[PostHogErasure] Job queue not running; PostHog person deletion not queued, replay it by hand', {
      event: 'posthog_person_deletion_not_queued',
      reason,
      distinctId,
    });
    return false;
  }
  try {
    await transaction.transaction(async (savepoint) => {
      const queueDb = enqueueOn(savepoint);
      for (const [pass, startAfter] of PASSES) {
        const job: PosthogPersonDeletionJob = { distinctId, reason, pass };
        const jobId = await boss.send(POSTHOG_PERSON_DELETION_QUEUE, job, { db: queueDb, startAfter });
        if (!jobId) throw new Error('POSTHOG_PERSON_DELETION_NOT_QUEUED');
      }
    });
    return true;
  } catch (error) {
    logger.error('[PostHogErasure] Could not queue PostHog person deletion, replay it by hand', {
      event: 'posthog_person_deletion_not_queued',
      reason,
      distinctId,
      error,
    });
    return false;
  }
}

const DEFAULT_POSTHOG_PROJECT_ID = '412845';
/** The private API host. Not the ingestion host (`us.i.posthog.com`) the capture client uses. */
const DEFAULT_POSTHOG_API_HOST = 'https://us.posthog.com';
const DELETE_REQUEST_TIMEOUT_MS = 30_000;
const LOOKUP_REQUEST_TIMEOUT_MS = 45_000;

/**
 * A dedicated key, not `POSTHOG_PERSONAL_API_KEY`: that one is read-scoped and
 * shared with refresh-recommendations and CI's OTA health check. This one needs
 * `person:write` and `query:read` on the project, nothing else.
 */
export const POSTHOG_ERASURE_API_KEY_ENV = 'POSTHOG_ERASURE_API_KEY';

type PosthogPrivateApiConfig = { apiKey: string; projectId: string; host: string };

function readEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function readPrivateApiConfig(): PosthogPrivateApiConfig | null {
  const apiKey = readEnv(POSTHOG_ERASURE_API_KEY_ENV);
  if (!apiKey) return null;
  return {
    apiKey,
    projectId: readEnv('POSTHOG_PROJECT_ID') ?? DEFAULT_POSTHOG_PROJECT_ID,
    host: (readEnv('POSTHOG_API_HOST') ?? DEFAULT_POSTHOG_API_HOST).replace(/\/+$/, ''),
  };
}

/**
 * The documented 2xx body of `bulk_delete` (PostHog's OpenAPI
 * `PersonBulkDeleteResponse`): `persons_found` and
 * `persons_queued_for_deletion` are required counts, `persons_deleted` a count
 * when present (0 when absent), and `deletion_errors`, optional in that schema,
 * a list when present. Anything else (truncated, not JSON, a proxy's HTML page)
 * is no proof that anything was deleted, so the job retries.
 *
 * PostHog answers in one of two modes (`PERSON_BULK_DELETE_ASYNC`): queued,
 * which PostHog Cloud documents (`persons_queued_for_deletion` equals
 * `persons_found`, `persons_deleted` is 0), or synchronous (`persons_deleted`
 * is what went, nothing is queued). Either way, a person is accounted for once
 * it is deleted or queued.
 */
const bulkDeleteResponseSchema = z
  .object({
    persons_found: z.number().int().nonnegative(),
    persons_deleted: z.number().int().nonnegative().optional(),
    persons_queued_for_deletion: z.number().int().nonnegative(),
    deletion_errors: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .passthrough();

const queryResponseSchema = z.object({ results: z.array(z.array(z.unknown())) }).passthrough();

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

export type PosthogPersonDeletionOutcome = 'discovered' | 'deleted' | 'skipped_non_production' | 'rejected';

/** Writes a discovery's ids where later steps and passes read them. */
export type PersistDiscoveredIds = (job: PosthogPersonDeletionJob, anonymousIds: string[]) => Promise<void>;

export type DeletePosthogPersonOptions = {
  fetchImpl?: typeof fetch;
  /** Where "is this id another account?" is answered. */
  database?: Database;
  /** Defaults to {@link persistDiscoveredIds} on the running queue. */
  persistDiscovery?: PersistDiscoveredIds;
  /** The pg-boss job id, for log lines an operator replays from. */
  jobId?: string;
};

/**
 * A key can be fixed, a project id or host corrected, and an outage ends; any
 * other 4xx is our request. 404 is in the first group: PostHog answers "no such
 * person" with a 202 and `persons_found: 0`, so a 404 means the URL is wrong
 * (`POSTHOG_PROJECT_ID`, `POSTHOG_API_HOST`), and completing the job on it would
 * record every erasure as done without deleting anything.
 */
function isRetryableStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 404 || status === 408 || status === 429 || status >= 500;
}

/** Statuses an operator must fix (key, project id, host): logged at error. */
function isConfigurationStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 404;
}

/** The request URL for a log line: host and path only, never the key (it travels in a header). */
function privateApiUrl(config: PosthogPrivateApiConfig, path: string): string {
  return `${config.host}/api/projects/${encodeURIComponent(config.projectId)}/${path}`;
}

type RequestContext = {
  config: PosthogPrivateApiConfig;
  fetchImpl: typeof fetch;
  reason: PosthogPersonDeletionReason;
  pass: PosthogPersonDeletionPass | undefined;
  jobId: string | undefined;
};

/** POST to the private API. A network error or a timeout throws a retryable error. */
async function postToPosthog(
  { config, fetchImpl, reason, pass }: RequestContext,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetchImpl(privateApiUrl(config, path), {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    logger.warn('[PostHogErasure] PostHog request failed; will retry', {
      event: 'posthog_person_deletion_retry',
      reason,
      pass,
      url: privateApiUrl(config, path),
      error,
    });
    throw new PosthogPersonDeletionRetryableError(`PostHog request to ${path} failed`);
  }
}

function throwRetryable(context: RequestContext, path: string, status: number, detail = 'refused the request'): never {
  const level = isConfigurationStatus(status) ? 'error' : 'warn';
  logger[level](`[PostHogErasure] PostHog ${detail}; will retry`, {
    event: 'posthog_person_deletion_retry',
    reason: context.reason,
    pass: context.pass,
    url: privateApiUrl(context.config, path),
    status,
  });
  throw new PosthogPersonDeletionRetryableError(`PostHog ${path} returned ${status}`, status);
}

/**
 * Counts only: a value that failed {@link isUsableDistinctId} is never logged.
 * An `identified_as` id leaves only the shared-phone check, never a deletion.
 */
function logDroppedAnonymousIds(
  { reason, pass, jobId }: Pick<RequestContext, 'reason' | 'pass' | 'jobId'>,
  dropped: number,
  source: 'lookup' | 'identified_as' | 'job',
): void {
  logger.warn('[PostHogErasure] Dropped values that are not usable distinct ids (no SDK mints them)', {
    event: 'posthog_person_deletion_invalid_ids_dropped',
    reason,
    pass,
    jobId,
    source,
    dropped,
  });
}

/**
 * The anonymous ids this account signed in from, through PostHog's own record
 * of it: every `$identify` the account sent names the id it switched away from
 * as `$anon_distinct_id`. Where PostHog merged that id into the account's
 * person, deleting it again is a no-op; where it refused (a split person), it
 * is the only way to reach that person.
 *
 * One HogQL query returns each such id with every distinct id that ever
 * identified from it, so an id another account also signed in from (a shared
 * phone) can be skipped: deleting it would erase that account's person.
 */
export const SPLIT_PERSON_QUERY = `
  SELECT toString(properties.$anon_distinct_id) AS anon_id, groupUniqArray(distinct_id) AS identified_as
  FROM events
  WHERE event = '$identify'
    AND toString(properties.$anon_distinct_id) IN (
      SELECT toString(properties.$anon_distinct_id)
      FROM events
      WHERE event = '$identify' AND distinct_id = {account_id}
    )
  GROUP BY anon_id
  LIMIT ${MAX_ANONYMOUS_IDS}
`;

async function findAnonymousIds(context: RequestContext, distinctId: string, database: Database): Promise<string[]> {
  const path = 'query/';
  const response = await postToPosthog(
    context,
    path,
    { query: { kind: 'HogQLQuery', query: SPLIT_PERSON_QUERY, values: { account_id: distinctId } } },
    LOOKUP_REQUEST_TIMEOUT_MS,
  );
  if (!response.ok) {
    if (isRetryableStatus(response.status)) throwRetryable(context, path, response.status);
    // Our query is wrong. Delete nothing: the delete would erase the `$identify`
    // events this lookup reads, and a fixed query could then never find the
    // split persons. Retry, then fail visibly, so the job can be replayed once
    // the query is fixed.
    logger.error('[PostHogErasure] PostHog rejected the anonymous id lookup; deleting nothing, will retry', {
      event: 'posthog_person_deletion_lookup_rejected',
      reason: context.reason,
      pass: context.pass,
      url: privateApiUrl(context.config, path),
      status: response.status,
    });
    throw new PosthogPersonDeletionRetryableError(`PostHog ${path} returned ${response.status}`, response.status);
  }

  const parsed = queryResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throwRetryable(context, path, response.status, 'answered the lookup with no result set');

  // Nothing skipped here can stop the account's own person from being erased:
  // the delete step always sends the account id.
  const candidates = new Map<string, string[]>();
  let unusable = 0;
  let unusableIdentifiedAs = 0;
  let crowded = 0;
  for (const [anonId, identifiedAs] of parsed.data.results) {
    if (typeof anonId !== 'string' || anonId === '' || anonId === distinctId) continue;
    // No SDK mints one: someone sent it with the public key. An over-long id, a
    // NUL or half a surrogate pair would fail every later step of this erasure.
    if (!isUsableDistinctId(anonId)) {
      unusable += 1;
      continue;
    }
    const identifiedAsList: unknown[] = Array.isArray(identifiedAs) ? identifiedAs : [];
    if (identifiedAsList.length > MAX_IDENTIFIED_AS_PER_ANONYMOUS_ID) {
      crowded += 1;
      continue;
    }
    const others: string[] = [];
    for (const id of identifiedAsList) {
      if (id === distinctId) continue;
      // Account ids are UUIDs, so an id that fails the check is no account and
      // leaving it out of the account check never hides a shared phone.
      if (isUsableDistinctId(id)) others.push(id);
      else unusableIdentifiedAs += 1;
    }
    candidates.set(anonId, others);
  }
  if (unusable > 0) logDroppedAnonymousIds(context, unusable, 'lookup');
  if (unusableIdentifiedAs > 0) logDroppedAnonymousIds(context, unusableIdentifiedAs, 'identified_as');

  // "Another account" is a live `users` row. The account being erased is never
  // in the set (its id is filtered out above, and on deletion its row is gone).
  // An id that is not an account (the party UUID a signed-out install
  // identified as before #6078) belongs to the same install and goes with it.
  const idsToCheck = [...new Set([...candidates.keys(), ...[...candidates.values()].flat()])];
  const otherAccounts = await findAccountIds(database, idsToCheck);

  const anonymousIds: string[] = [];
  let shared = 0;
  for (const [anonId, others] of candidates) {
    if (otherAccounts.has(anonId) || others.some((id) => otherAccounts.has(id))) {
      shared += 1;
      continue;
    }
    anonymousIds.push(anonId);
  }
  if (shared > 0 || crowded > 0) {
    logger.info('[PostHogErasure] Skipped anonymous ids that are shared or crowded', {
      event: 'posthog_person_deletion_shared_ids_skipped',
      reason: context.reason,
      pass: context.pass,
      shared,
      crowded,
    });
  }
  return anonymousIds;
}

/**
 * The ids in `ids` that are live accounts, {@link ACCOUNT_LOOKUP_CHUNK_SIZE} per
 * query: one query carrying them all could pass the driver's parameter limit,
 * and that error would block every pass of the erasure.
 */
async function findAccountIds(database: Database, ids: string[]): Promise<Set<string>> {
  const accountIds = new Set<string>();
  for (let start = 0; start < ids.length; start += ACCOUNT_LOOKUP_CHUNK_SIZE) {
    const rows = await database
      .select({ id: dbSchema.users.id })
      .from(dbSchema.users)
      .where(inArray(dbSchema.users.id, ids.slice(start, start + ACCOUNT_LOOKUP_CHUNK_SIZE)));
    for (const row of rows) accountIds.add(row.id);
  }
  return accountIds;
}

/**
 * Persist a discovery before anything is deleted, in one transaction:
 *
 * 1. every erasure of this account still waiting (the late pass, another
 *    trigger's first pass) gets the ids added, so it can erase them after this
 *    pass has deleted the `$identify` events they came from;
 * 2. this pass continues as a `delete` job carrying them, so its retries reuse
 *    them.
 *
 * A crash between this and the discovery job completing runs the discovery
 * again and queues a second delete, which is harmless.
 */
export async function persistDiscoveredIds(
  boss: PgBoss,
  job: PosthogPersonDeletionJob,
  anonymousIds: string[],
): Promise<void> {
  await db.transaction(async (transaction) => {
    const queueDb = enqueueOn(transaction);
    const waiting = await boss.findJobs<PosthogPersonDeletionJob>(POSTHOG_PERSON_DELETION_QUEUE, {
      data: { distinctId: job.distinctId },
      queued: true,
      db: queueDb,
    });
    for (const pending of waiting) {
      // Saved by an earlier pass, so checked again; the waiting job never sees
      // what is dropped here, so this is the only place to count it.
      const saved = sanitizeAnonymousIds(pending.data.anonymousIds);
      if (saved.dropped > 0) {
        logDroppedAnonymousIds(
          { reason: pending.data.reason, pass: pending.data.pass, jobId: pending.id },
          saved.dropped,
          'job',
        );
      }
      const merged = mergeAnonymousIds(saved.ids, anonymousIds);
      await boss.update(
        POSTHOG_PERSON_DELETION_QUEUE,
        { ...pending.data, anonymousIds: merged },
        {
          id: pending.id,
          db: queueDb,
        },
      );
    }
    const deleteStep: PosthogPersonDeletionJob = {
      distinctId: job.distinctId,
      reason: job.reason,
      pass: job.pass,
      anonymousIds,
      stage: 'delete',
    };
    const jobId = await boss.send(POSTHOG_PERSON_DELETION_QUEUE, deleteStep, { db: queueDb });
    if (!jobId) throw new Error('POSTHOG_PERSON_DELETION_DELETE_STEP_NOT_QUEUED');
  });
}

/**
 * Union, first-seen order, capped at what one `bulk_delete` takes beside the
 * account id. Both lists are already checked.
 */
function mergeAnonymousIds(persisted: string[], discovered: string[]): string[] {
  return sanitizeAnonymousIds([...persisted, ...discovered]).ids;
}

/**
 * The distinct id of a job that failed the schema, for the replay log line:
 * cut to the longest id a job carries, absent when it is not a string.
 */
function rawDistinctId(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null || !('distinctId' in payload)) return undefined;
  const { distinctId } = payload;
  return typeof distinctId === 'string' ? distinctId.slice(0, MAX_DISTINCT_ID_LENGTH) : undefined;
}

/**
 * One step of an erasure:
 *
 * - **Discover** (no `stage`): HogQL (`query:read`) for the anonymous ids the
 *   account signed in from, merged with any the job already carries, then
 *   persisted ({@link persistDiscoveredIds}). Returns `discovered`. Any lookup
 *   failure, a rejected query included, throws before anything is deleted.
 * - **Delete** (`stage: 'delete'`): `POST /api/projects/:id/persons/bulk_delete/`
 *   (`person:write`) with the account id and the persisted ids, events and
 *   recordings included.
 *
 * An anonymous id longer than {@link MAX_DISTINCT_ID_LENGTH}, carrying a
 * character PostgreSQL cannot store ({@link UNSTORABLE_CHARACTER}), or not a
 * string, is dropped (counted in `posthog_person_deletion_invalid_ids_dropped`)
 * at either step, never persisted, and never fails the job: the account id is
 * always sent. A job whose `distinctId`, `reason`, `pass` or `stage` fails the
 * schema is `rejected`, logged with its job id and distinct id for a replay.
 *
 * - 2xx with the documented body: done when `deletion_errors` is empty and
 *   `persons_deleted + persons_queued_for_deletion >= persons_found` (no
 *   matching person is a 202 with every count zero, still done). A non-empty
 *   `deletion_errors`, fewer persons deleted or queued than matched, or a 2xx
 *   body that is not the documented shape, throws so the job retries.
 * - 401, 403, 404, 408, 429, 5xx, a timeout or a network error, on either
 *   call: throws. A key, a project id or a host can be fixed and an outage
 *   ends, so pg-boss retries. 401/403/404 log at error with the URL.
 * - Any other 4xx from the delete: the request itself is wrong and a retry
 *   would send it again. Logged as an error and returned as `rejected`, which
 *   the worker turns into a failed job.
 *
 * Only production calls PostHog, the same gate as backend capture: a dev or
 * preview backend must never delete a person in the production project.
 */
export async function deletePosthogPerson(
  payload: unknown,
  {
    fetchImpl = fetch,
    database = db,
    persistDiscovery = (job, anonymousIds) => persistDiscoveredIds(requireJobQueue(), job, anonymousIds),
    jobId,
  }: DeletePosthogPersonOptions = {},
): Promise<PosthogPersonDeletionOutcome> {
  const parsed = jobSchema.safeParse(payload);
  if (!parsed.success) {
    logger.error('[PostHogErasure] Dropped a malformed person deletion job', {
      event: 'posthog_person_deletion_invalid_job',
      jobId,
      distinctId: rawDistinctId(payload),
      invalidFields: [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))],
    });
    return 'rejected';
  }
  const { anonymousIds: rawAnonymousIds, ...fields } = parsed.data;
  const sanitized = sanitizeAnonymousIds(rawAnonymousIds);
  const job: PosthogPersonDeletionJob =
    rawAnonymousIds === undefined ? fields : { ...fields, anonymousIds: sanitized.ids };
  const { distinctId, reason, pass } = job;
  if (sanitized.dropped > 0) logDroppedAnonymousIds({ reason, pass, jobId }, sanitized.dropped, 'job');

  const environment = getAnalyticsEnvironment();
  if (environment !== 'production') {
    logger.info('[PostHogErasure] Not production; PostHog person deletion skipped', {
      event: 'posthog_person_deletion_skipped',
      environment,
      reason,
      pass,
    });
    return 'skipped_non_production';
  }

  const config = readPrivateApiConfig();
  if (!config) {
    logger.error(`[PostHogErasure] ${POSTHOG_ERASURE_API_KEY_ENV} is not set; PostHog person deletion will retry`, {
      event: 'posthog_person_deletion_unconfigured',
      reason,
      pass,
    });
    throw new PosthogPersonDeletionRetryableError(`${POSTHOG_ERASURE_API_KEY_ENV} is not set`);
  }
  const context: RequestContext = { config, fetchImpl, reason, pass, jobId };

  if (job.stage !== 'delete') {
    // Step 1. Any lookup failure throws before anything is deleted.
    const discovered = await findAnonymousIds(context, distinctId, database);
    const anonymousIds = mergeAnonymousIds(job.anonymousIds ?? [], discovered);
    await persistDiscovery(job, anonymousIds);
    logger.info('[PostHogErasure] Anonymous ids discovered and persisted; delete step queued', {
      event: 'posthog_person_deletion_discovered',
      reason,
      pass,
      discovered: discovered.length,
      anonymousIds: anonymousIds.length,
    });
    return 'discovered';
  }

  // Step 2. The ids come from the job, never from a new lookup.
  const anonymousIds = job.anonymousIds ?? [];
  const path = 'persons/bulk_delete/';
  const response = await postToPosthog(
    context,
    path,
    { distinct_ids: [distinctId, ...anonymousIds], delete_events: true, delete_recordings: true },
    DELETE_REQUEST_TIMEOUT_MS,
  );

  const { status } = response;
  if (status < 200 || status >= 300) {
    if (isRetryableStatus(status)) throwRetryable(context, path, status);
    logger.error('[PostHogErasure] PostHog rejected the person deletion request; not retrying', {
      event: 'posthog_person_deletion_rejected',
      reason,
      pass,
      url: privateApiUrl(config, path),
      status,
    });
    return 'rejected';
  }

  // Only the documented body proves the deletion was taken.
  const body = bulkDeleteResponseSchema.safeParse(await response.json().catch(() => null));
  if (!body.success) throwRetryable(context, path, status, 'answered the delete without the documented body');
  const result = body.data;
  if (result.deletion_errors && result.deletion_errors.length > 0) {
    logger.warn('[PostHogErasure] PostHog reported an incomplete person deletion; will retry', {
      event: 'posthog_person_deletion_retry',
      reason,
      pass,
      status,
      deletionErrors: result.deletion_errors.length,
    });
    throw new PosthogPersonDeletionRetryableError('PostHog reported deletion_errors', status);
  }
  const personsDeleted = result.persons_deleted ?? 0;
  if (personsDeleted + result.persons_queued_for_deletion < result.persons_found) {
    logger.warn('[PostHogErasure] PostHog neither deleted nor queued every matched person; will retry', {
      event: 'posthog_person_deletion_retry',
      reason,
      pass,
      status,
      personsFound: result.persons_found,
      personsDeleted,
      personsQueuedForDeletion: result.persons_queued_for_deletion,
    });
    throw new PosthogPersonDeletionRetryableError('PostHog accounted for fewer persons than it matched', status);
  }
  logger.info('[PostHogErasure] PostHog person deletion accepted', {
    event: 'posthog_person_deletion_accepted',
    reason,
    pass,
    status,
    anonymousIds: anonymousIds.length,
    personsFound: result.persons_found,
    personsDeleted,
    personsQueuedForDeletion: result.persons_queued_for_deletion,
  });
  return 'deleted';
}

export type StartPosthogPersonDeletionOptions = {
  /** Test-only: poll faster than the maintenance default. */
  pollingIntervalSeconds?: number;
  fetchImpl?: typeof fetch;
};

type ErasureJobOutput = { outcome: PosthogPersonDeletionOutcome } | { error: string };

/** Enough of an error for an operator. */
const MAX_OUTPUT_ERROR_LENGTH = 1000;

/**
 * What a job's output says about a failure. drizzle's `DrizzleQueryError` puts
 * the SQL and every parameter in `message` (the parameters can be other
 * accounts' ids, kept 7 days in `pgboss.job`) and the driver's error in
 * `cause`. So an error with a cause is stored as its class name and the cause's
 * message and code, never its own message; a failed query without one is
 * stored as its class name alone.
 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  // DrizzleQueryError never sets `name`, so it reads "Error".
  const name = error.name === 'Error' ? error.constructor.name : error.name;
  const { cause } = error;
  if (cause instanceof Error) {
    const code = 'code' in cause && typeof cause.code === 'string' ? ` (${cause.code})` : '';
    return `${name}: ${cause.message}${code}`;
  }
  return error instanceof DrizzleQueryError ? name : error.message;
}

/**
 * {@link describeError}, as text pg-boss can store as a job's output: pg-boss
 * cannot write a NUL or half a surrogate pair into the output, and records its
 * own jsonb error instead, losing the real one. Cut first: the cut can split a
 * surrogate pair, and the replace then removes the stray half.
 */
function storableErrorText(error: unknown): string {
  return describeError(error).slice(0, MAX_OUTPUT_ERROR_LENGTH).replace(UNSTORABLE_CHARACTERS, ' ');
}

/** One job's pg-boss disposition: completed, failed (retried), or failed for good. */
async function settleErasureJob(
  boss: PgBoss,
  job: JobWithMetadata<PosthogPersonDeletionJob>,
  fetchImpl: typeof fetch | undefined,
): Promise<JobResult<ErasureJobOutput>> {
  try {
    const outcome = await deletePosthogPerson(job.data, {
      fetchImpl,
      persistDiscovery: (data, anonymousIds) => persistDiscoveredIds(boss, data, anonymousIds),
      jobId: job.id,
    });
    // `deadletter` with no dead letter queue fails the job at once, skipping
    // retries a broken request would only repeat. It stays in `pgboss.job`
    // as `failed` for an operator, not `completed`.
    return { id: job.id, status: outcome === 'rejected' ? 'deadletter' : 'completed', output: { outcome } };
  } catch (error) {
    if (job.retryCount >= job.retryLimit) {
      logger.error('[PostHogErasure] PostHog person deletion out of retries; replay it by hand', {
        event: 'posthog_person_deletion_exhausted',
        reason: job.data.reason,
        pass: job.data.pass,
        jobId: job.id,
      });
    }
    return { id: job.id, status: 'failed', output: { error: storableErrorText(error) } };
  }
}

/**
 * Work the erasure queue on this replica, but only on a production backend
 * that holds {@link POSTHOG_ERASURE_API_KEY_ENV}. Anywhere else no worker is
 * registered and jobs wait in `created` (up to the queue's 14-day
 * `retentionSeconds`) without spending a retry, so setting the key later still
 * erases every one of them. A worker without the key would burn the 12 retries
 * in about 30 hours and lose the job. The migrator creates the queue.
 *
 * Returns whether the worker was registered.
 */
export async function startPosthogPersonDeletion(
  boss: PgBoss,
  { pollingIntervalSeconds = MAINTENANCE_POLLING_INTERVAL_SECONDS, fetchImpl }: StartPosthogPersonDeletionOptions = {},
): Promise<boolean> {
  const environment = getAnalyticsEnvironment();
  const configured = readPrivateApiConfig() !== null;
  if (environment !== 'production' || !configured) {
    const level = environment === 'production' ? 'error' : 'info';
    logger[level]('[PostHogErasure] Not working the PostHog erasure queue on this backend; jobs wait', {
      event: 'posthog_person_deletion_unconfigured',
      environment,
      keySet: configured,
    });
    return false;
  }
  await boss.work(
    POSTHOG_PERSON_DELETION_QUEUE,
    { localConcurrency: 1, batchSize: 1, pollingIntervalSeconds, includeMetadata: true, perJobResults: true },
    async (jobs: JobWithMetadata<PosthogPersonDeletionJob>[]) =>
      Promise.all(jobs.map((job) => settleErasureJob(boss, job, fetchImpl))),
  );
  return true;
}
