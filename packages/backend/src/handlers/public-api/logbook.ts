import {
  LogbookChangesQuerySchema,
  LogbookChangesResponseSchema,
  type LogbookChange,
  type LogbookChangesResponse,
} from '@boardsesh/public-api';
import {
  readLogbookFeedPage,
  readLogbookTick,
  type LogbookFeedEntry,
  type LogbookPageReader,
} from '../../services/logbook-feed';
import {
  LOGBOOK_SNAPSHOT_TTL_SECONDS,
  advanceLogbookSnapshotBuild,
  readLogbookSnapshotPage,
  startLogbookSnapshot,
  type LogbookSnapshotBinding,
  type LogbookSnapshotCursor,
  type LogbookSnapshotPage,
} from '../../services/logbook-snapshot';
import { serializeLogbookTick, type LogbookClimbMetadata } from '../../services/logbook-tick-serializer';
import { logger } from '../../utils/logger';
import { getPostgresErrorCode } from '../../utils/postgres-errors';
import { chargePartnerLimit, peekPartnerLimit } from '../partner-rate-limits';
import { TEST_EXPIRED_CURSOR, decodeLogbookCursor, encodeLogbookCursor, type LogbookCursor } from './logbook-cursor';
import { CHALLENGE_INVALID_TOKEN, errorOutcome, unauthorized, unavailable, type ApiOutcome } from './outcome';
import type { PartnerRuntime } from './router';

/**
 * `GET /v1/logbook/changes` and `GET /v1/logbook/ticks/{id}` (docs/partner-api.md,
 * section 3). The router has already checked the token, charged the limits and
 * holds a `/v1` admission permit on the partner pool when these run.
 *
 * - A change cursor reads the feed on the partner pool under that permit.
 * - No cursor, or a snapshot cursor, is snapshot work: the permit goes back
 *   first and the work takes a permit on the snapshot pool instead, so a build
 *   never holds one of the two `/v1` connections.
 * - A statement or lock timeout is an empty page at the same cursor with
 *   `hasMore: true`; the app simply asks again.
 */

type PartnerApiPrincipal = Parameters<PartnerRuntime['api']['readClimber']>[0];
type PartnerLogbook = PartnerRuntime['logbook'];

export const LOGBOOK_READ_SCOPE = 'logbook:read';
/** `docs/integration-platform.md`, "Limits": 2 new snapshots a minute per connection. Joins are free. */
const SNAPSHOTS_CREATED_PER_CONNECTION = 2;
/**
 * Snapshot storage frees only when the reclaim job runs (every 15 minutes), so
 * an app refused for capacity has nothing to gain by asking sooner.
 */
const CAPACITY_RETRY_AFTER_SECONDS = 900;
/** Tick ids are uuids. Anything else names no tick. */
const TICK_ID = /^[A-Za-z0-9-]{1,64}$/;

const STATEMENT_TIMEOUT_CODE = '57014';
const LOCK_TIMEOUT_CODE = '55P03';

function ranOutOfTime(error: unknown): boolean {
  const code = getPostgresErrorCode(error);
  return code === STATEMENT_TIMEOUT_CODE || code === LOCK_TIMEOUT_CODE;
}

export interface LogbookRouteContext {
  logbook: PartnerLogbook;
  principal: PartnerApiPrincipal;
  requestId: string;
  /** Hands the `/v1` permit back before snapshot work. Safe to call twice. */
  releaseApiPermit: () => void;
}

/** RFC 6750 section 3.1. */
function insufficientScope(requestId: string): ApiOutcome {
  return errorOutcome(403, 'insufficient_scope', 'This call needs the logbook:read scope.', requestId, {
    headers: { 'www-authenticate': `Bearer error="insufficient_scope", scope="${LOGBOOK_READ_SCOPE}"` },
    refusal: 'insufficient_scope',
  });
}

function cursorExpired(requestId: string, refusal: string): ApiOutcome {
  return errorOutcome(
    410,
    'cursor_expired',
    'This cursor can no longer be followed. Persist that a full sync is required, then start without a cursor.',
    requestId,
    { refusal },
  );
}

function connectionEnded(requestId: string): ApiOutcome {
  return unauthorized(requestId, CHALLENGE_INVALID_TOKEN, 'connection_ended');
}

/** A build that ended `too_large` or `stalled`. Terminal for that snapshot: nothing resumes it, and a restart is refused until the verdict lapses. */
function snapshotEnded(requestId: string, reason: 'too_large' | 'stalled', retryAfterSeconds: number): ApiOutcome {
  return unavailable(requestId, {
    retryAfterSeconds,
    message:
      reason === 'too_large'
        ? 'This logbook is too large to download as one snapshot. Try again after Retry-After.'
        : 'The snapshot of this logbook could not be built. Try again after Retry-After.',
    refusal: `snapshot_${reason}`,
  });
}

function hasLogbookScope(principal: PartnerApiPrincipal): boolean {
  return principal.scopes.includes(LOGBOOK_READ_SCOPE);
}

/**
 * Serializes a page's entries with the metadata read in the same transaction.
 */
function presentEntries(entries: readonly LogbookFeedEntry[], metadata: LogbookClimbMetadata | null): LogbookChange[] {
  return entries.map((entry): LogbookChange => {
    if (entry.type === 'tick.deleted') return { type: 'tick.deleted', id: entry.id };
    if (!metadata) throw new Error('A logbook page served ticks without reading their metadata.');
    return { type: 'tick', tick: serializeLogbookTick(entry.tick, metadata) };
  });
}

function page(changes: LogbookChange[], cursor: string, hasMore: boolean): ApiOutcome {
  const body: LogbookChangesResponse = LogbookChangesResponseSchema.parse({ changes, cursor, hasMore });
  return { status: 200, body };
}

/** Collects the metadata a page's read transaction loaded. */
function metadataCollector(logbook: PartnerLogbook, principal: PartnerApiPrincipal) {
  let metadata: LogbookClimbMetadata | null = null;
  const reader: LogbookPageReader = logbook.pageReader(principal, (loaded) => {
    metadata = loaded;
  });
  return { reader, metadata: () => metadata };
}

export async function serveLogbookTick(context: LogbookRouteContext, tickId: string | undefined): Promise<ApiOutcome> {
  const { logbook, principal, requestId } = context;
  if (!hasLogbookScope(principal)) return insufficientScope(requestId);
  const notFound = errorOutcome(404, 'not_found', 'No such tick for this climber.', requestId, {
    refusal: 'not_found',
  });
  if (tickId === undefined || !TICK_ID.test(tickId)) return notFound;

  const collected = metadataCollector(logbook, principal);
  try {
    const tick = await readLogbookTick(logbook.feed, {
      userId: principal.userId,
      tickUuid: tickId,
      withinRead: collected.reader,
    });
    if (!tick) return notFound;
    const metadata = collected.metadata();
    if (!metadata) throw new Error('A tick was read without its metadata.');
    return { status: 200, body: serializeLogbookTick(tick, metadata) };
  } catch (error) {
    if (logbook.isConnectionEnded(error)) return connectionEnded(requestId);
    if (ranOutOfTime(error)) return unavailable(requestId);
    throw error;
  }
}

export async function serveLogbookChanges(context: LogbookRouteContext, requestTarget: string): Promise<ApiOutcome> {
  const { logbook, principal, requestId } = context;
  if (!hasLogbookScope(principal)) return insufficientScope(requestId);

  const searchParams = new URL(requestTarget, 'https://api.boardsesh.invalid').searchParams;
  const query = LogbookChangesQuerySchema.safeParse({
    cursor: searchParams.get('cursor') ?? undefined,
    limit: searchParams.get('limit') ?? undefined,
  });
  if (!query.success) {
    const field = query.error.issues[0]?.path[0] === 'cursor' ? 'cursor' : 'limit';
    const message = field === 'cursor' ? 'cursor must not be empty.' : 'limit must be a whole number from 1 to 200.';
    return errorOutcome(400, 'invalid_request', message, requestId, { field, refusal: 'invalid_request' });
  }
  const { cursor: rawCursor, limit } = query.data;

  if (rawCursor === undefined) return serveSnapshot(context, { start: true, limit });
  if (rawCursor === TEST_EXPIRED_CURSOR) return cursorExpired(requestId, 'test_cursor');

  const decoded = decodeLogbookCursor(rawCursor, logbook.cursorSecrets);
  if (decoded.status === 'invalid') {
    return errorOutcome(400, 'invalid_cursor', 'cursor is not a value this API issued.', requestId, {
      field: 'cursor',
      refusal: 'invalid_cursor',
    });
  }
  if (decoded.status === 'expired') return cursorExpired(requestId, 'retired_secret');
  const { cursor } = decoded;
  // A cursor from another app's connection, or from before a reconnect.
  if (
    cursor.connectionId !== principal.connectionId ||
    cursor.connectionGeneration !== principal.connectionGeneration
  ) {
    return cursorExpired(requestId, 'other_connection');
  }

  if (cursor.kind === 'changes') return serveFeedPage(context, cursor, rawCursor, limit);
  return serveSnapshot(context, {
    start: false,
    limit,
    cursor: { snapshotId: cursor.snapshotId, position: cursor.position },
  });
}

async function serveFeedPage(
  context: LogbookRouteContext,
  cursor: Extract<LogbookCursor, { kind: 'changes' }>,
  rawCursor: string,
  limit: number,
): Promise<ApiOutcome> {
  const { logbook, principal, requestId } = context;
  const collected = metadataCollector(logbook, principal);
  try {
    const feedPage = await readLogbookFeedPage(logbook.feed, {
      userId: principal.userId,
      cursor: { generation: cursor.feedGeneration, txid: cursor.txid, seq: cursor.seq },
      limit,
      withinRead: collected.reader,
    });
    if (feedPage.status === 'expired') return cursorExpired(requestId, feedPage.reason);
    const next = encodeLogbookCursor(
      {
        kind: 'changes',
        connectionId: principal.connectionId,
        connectionGeneration: principal.connectionGeneration,
        feedGeneration: feedPage.generation,
        txid: feedPage.next.txid,
        seq: feedPage.next.seq,
      },
      logbook.cursorSecrets,
    );
    return page(presentEntries(feedPage.entries, collected.metadata()), next, feedPage.hasMore);
  } catch (error) {
    if (logbook.isConnectionEnded(error)) return connectionEnded(requestId);
    // Nothing was read: the same cursor again.
    if (ranOutOfTime(error)) return page([], rawCursor, true);
    throw error;
  }
}

type SnapshotRequest = { start: true; limit: number } | { start: false; limit: number; cursor: LogbookSnapshotCursor };

/**
 * Starts or joins a snapshot (no cursor), or continues one, then serves its
 * next page. While it builds, this request drives the build for up to a second
 * when a build permit is free, and the page is empty with `hasMore: true`.
 */
async function serveSnapshot(context: LogbookRouteContext, request: SnapshotRequest): Promise<ApiOutcome> {
  const { logbook, principal, requestId } = context;
  context.releaseApiPermit();
  const binding: LogbookSnapshotBinding = {
    userId: principal.userId,
    connectionId: principal.connectionId,
    connectionGeneration: principal.connectionGeneration,
  };
  const snapshotCursor = (cursor: LogbookSnapshotCursor) =>
    encodeLogbookCursor(
      {
        kind: 'snapshot',
        connectionId: principal.connectionId,
        connectionGeneration: principal.connectionGeneration,
        snapshotId: cursor.snapshotId,
        position: cursor.position,
      },
      logbook.cursorSecrets,
    );

  let cursor: LogbookSnapshotCursor;
  if (request.start) {
    const started = await startSnapshot(context, binding);
    if ('outcome' in started) return started.outcome;
    cursor = started.cursor;
  } else {
    cursor = request.cursor;
  }

  const collected = metadataCollector(logbook, principal);
  try {
    let snapshotPage = await readSnapshotPage(logbook, binding, cursor, request.limit, collected.reader);
    if (snapshotPage === null) return unavailable(requestId);

    if (snapshotPage.status === 'building') {
      const build = logbook.snapshotAdmission.tryBuild();
      if (build) {
        let progress: Awaited<ReturnType<typeof advanceLogbookSnapshotBuild>>;
        try {
          progress = await advanceLogbookSnapshotBuild(logbook.snapshots, { binding, snapshotId: cursor.snapshotId });
        } finally {
          build.release();
        }
        if (progress.status === 'too_large' || progress.status === 'stalled') {
          // The verdict was written just now, so it lasts the whole TTL.
          return snapshotEnded(requestId, progress.status, LOGBOOK_SNAPSHOT_TTL_SECONDS);
        }
        if (progress.status === 'expired') return cursorExpired(requestId, 'snapshot_expired');
        if (progress.status === 'ready') {
          snapshotPage = await readSnapshotPage(logbook, binding, cursor, request.limit, collected.reader);
          if (snapshotPage === null) return page([], snapshotCursor(cursor), true);
        }
      }
    }

    if (snapshotPage.status === 'building') return page([], snapshotCursor(cursor), true);
    if (snapshotPage.status === 'expired') {
      if (snapshotPage.reason === 'too_large' || snapshotPage.reason === 'stalled') {
        return snapshotEnded(requestId, snapshotPage.reason, snapshotPage.retryAfterSeconds);
      }
      return cursorExpired(requestId, snapshotPage.reason);
    }

    const next =
      snapshotPage.next.kind === 'snapshot'
        ? snapshotCursor(snapshotPage.next.cursor)
        : encodeLogbookCursor(
            {
              kind: 'changes',
              connectionId: principal.connectionId,
              connectionGeneration: principal.connectionGeneration,
              feedGeneration: snapshotPage.next.cursor.generation,
              txid: snapshotPage.next.cursor.txid,
              seq: snapshotPage.next.cursor.seq,
            },
            logbook.cursorSecrets,
          );
    return page(presentEntries(snapshotPage.entries, collected.metadata()), next, true);
  } catch (error) {
    if (logbook.isConnectionEnded(error)) return connectionEnded(requestId);
    if (ranOutOfTime(error)) return page([], snapshotCursor(cursor), true);
    throw error;
  }
}

/** A page read on the snapshot pool, or null when its queue is full. */
async function readSnapshotPage(
  logbook: PartnerLogbook,
  binding: LogbookSnapshotBinding,
  cursor: LogbookSnapshotCursor,
  limit: number,
  withinRead: LogbookPageReader,
): Promise<LogbookSnapshotPage | null> {
  const permit = await logbook.snapshotAdmission.acquireRead();
  if (!permit) return null;
  try {
    return await readLogbookSnapshotPage(logbook.snapshots, { binding, cursor, limit, withinRead });
  } finally {
    permit.release();
  }
}

/**
 * Starts or joins this connection's snapshot. Only a real creation counts
 * against the creation limit: with the limit spent, a request that would join
 * still joins, and only one that would create gets the 429.
 */
async function startSnapshot(
  context: LogbookRouteContext,
  binding: LogbookSnapshotBinding,
): Promise<{ cursor: LogbookSnapshotCursor } | { outcome: ApiOutcome }> {
  const { logbook, principal, requestId } = context;
  const limitIdentity = `${principal.clientId}:${principal.userId}`;
  const limited = await peekPartnerLimit(limitIdentity, 'api-snapshot-create', SNAPSHOTS_CREATED_PER_CONNECTION);

  const permit = await logbook.snapshotAdmission.acquireRead();
  if (!permit) return { outcome: unavailable(requestId) };
  let started: Awaited<ReturnType<typeof startLogbookSnapshot>>;
  try {
    started = await startLogbookSnapshot(logbook.snapshots, binding, { createAllowed: limited === null });
  } finally {
    permit.release();
  }

  if (started.status === 'started') {
    if (started.created) {
      await chargePartnerLimit(limitIdentity, 'api-snapshot-create');
      logger.info('Partner logbook snapshot started', { requestId, clientId: principal.clientId });
    }
    return { cursor: started.cursor };
  }
  switch (started.reason) {
    case 'creation_limited':
      if (!limited) throw new Error('A snapshot start was limited without a limit.');
      throw limited;
    case 'capacity':
      return {
        outcome: unavailable(requestId, {
          retryAfterSeconds: CAPACITY_RETRY_AFTER_SECONDS,
          message: 'Logbook downloads are at capacity. Try again after Retry-After.',
          refusal: 'snapshot_capacity',
        }),
      };
    case 'busy':
      return { outcome: unavailable(requestId, { refusal: 'snapshot_busy' }) };
    case 'too_large':
    case 'stalled':
      return { outcome: snapshotEnded(requestId, started.reason, started.retryAfterSeconds) };
  }
}
