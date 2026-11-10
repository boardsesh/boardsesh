import { and, eq, isNull } from 'drizzle-orm';
import { oauthConnections } from '@boardsesh/db/schema/auth';
import type { Database } from '../../db/client';
import type { FeedTransaction, LogbookFeedTick, LogbookPageReader } from '../../services/logbook-feed';
import { readLogbookClimbMetadata, type LogbookClimbMetadata } from '../../services/logbook-tick-serializer';
import type { PartnerAdmissionPermit } from './admission';
import type { PartnerApiPrincipal } from './bearer';
import type { PartnerSecret } from './configuration';

/**
 * What the logbook routes (`GET /v1/logbook/changes`, `GET /v1/logbook/ticks/{id}`)
 * run on. Built with the rest of the partner runtime, so with
 * `PARTNER_OAUTH_MODE=off` none of it exists and no pool opens.
 *
 * Two pools, both on the primary: a lagging replica read would answer a valid
 * cursor with 410.
 * - Feed pages and single ticks run on the partner pool, inside the `/v1`
 *   admission permit the token check already holds. They are short indexed
 *   reads, bounded at 5 s.
 * - Snapshots (start, build, page reads) run on a pool of their own, so a cold
 *   build chunk, which can take the full 5 s statement timeout, never holds a
 *   connection that token refreshes or first-party queries need.
 */

/**
 * Connections per backend process for snapshot work. One may build and one
 * serves starts and page reads. The build slots are cluster-wide
 * (`LOGBOOK_SNAPSHOT_BUILD_SLOTS`, 2), so two replicas still use both. The
 * budget is in docs/db-connectivity.md, "Dedicated pools".
 */
export const LOGBOOK_SNAPSHOT_POOL_MAX = 2;

export interface LogbookSnapshotAdmissionLimits {
  permits: number;
  /** Builds at once in this process. A build never waits: with none free it is skipped and the page says "building". */
  buildPermits: number;
  /** Starts and page reads that may wait for a permit, and how long. */
  queueLimit: number;
  queueDeadlineMs: number;
}

export const LOGBOOK_SNAPSHOT_ADMISSION_LIMITS: LogbookSnapshotAdmissionLimits = {
  permits: LOGBOOK_SNAPSHOT_POOL_MAX,
  buildPermits: 1,
  queueLimit: 8,
  queueDeadlineMs: 1000,
};

/**
 * Keeps the snapshot pool's queue bounded, the way the partner admission gate
 * keeps the partner pool's (postgres.js would queue without a cap or a
 * deadline). A start or page read waits briefly; a build is tried, never queued.
 */
export interface LogbookSnapshotAdmission {
  tryBuild(): PartnerAdmissionPermit | null;
  acquireRead(): Promise<PartnerAdmissionPermit | null>;
}

export function createLogbookSnapshotAdmission(limits: LogbookSnapshotAdmissionLimits): LogbookSnapshotAdmission {
  let running = 0;
  let runningBuilds = 0;
  const waiting: Array<{
    grant: (permit: PartnerAdmissionPermit | null) => void;
    deadline: ReturnType<typeof setTimeout>;
  }> = [];

  function startRunning(build: boolean): PartnerAdmissionPermit {
    running += 1;
    if (build) runningBuilds += 1;
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        running -= 1;
        if (build) runningBuilds -= 1;
        while (waiting.length > 0 && running < limits.permits) {
          const next = waiting.shift() as (typeof waiting)[number];
          clearTimeout(next.deadline);
          next.grant(startRunning(false));
        }
      },
    };
  }

  return {
    tryBuild() {
      if (running >= limits.permits || runningBuilds >= limits.buildPermits) return null;
      return startRunning(true);
    },
    acquireRead() {
      if (running < limits.permits && waiting.length === 0) return Promise.resolve(startRunning(false));
      if (waiting.length >= limits.queueLimit) return Promise.resolve(null);
      return new Promise((resolve) => {
        const waiter = {
          grant: resolve,
          deadline: setTimeout(() => {
            waiting.splice(waiting.indexOf(waiter), 1);
            resolve(null);
          }, limits.queueDeadlineMs),
        };
        waiter.deadline.unref();
        waiting.push(waiter);
      });
    },
  };
}

/** The connection behind a token ended between the token check and the page. Answer 401. */
export class PartnerConnectionEnded extends Error {
  constructor() {
    super('The partner connection ended during the request');
    this.name = 'PartnerConnectionEnded';
  }
}

/**
 * Checks the connection again inside a page's read transaction, then reads the
 * climbs' public metadata in the same snapshot. The token check read the
 * connection a moment earlier; this makes a Disconnect or a revocation that
 * committed in between end the page too, and fails closed if the row is gone.
 */
export function logbookPageReader(
  principal: PartnerApiPrincipal,
  onMetadata: (metadata: LogbookClimbMetadata) => void,
): LogbookPageReader {
  return async (transaction: FeedTransaction, ticks: LogbookFeedTick[]) => {
    const [current] = await transaction
      .select({ id: oauthConnections.id })
      .from(oauthConnections)
      .where(
        and(
          eq(oauthConnections.id, principal.connectionId),
          eq(oauthConnections.userId, principal.userId),
          eq(oauthConnections.clientId, principal.clientId),
          eq(oauthConnections.generation, principal.connectionGeneration),
          isNull(oauthConnections.revokedAt),
        ),
      );
    if (!current) throw new PartnerConnectionEnded();
    onMetadata(await readLogbookClimbMetadata(transaction, principal.userId, ticks));
  };
}

export interface PartnerLogbookDatabases {
  /** Full-schema handle on the partner pool: feed pages and single ticks. */
  feed: Database;
  /** Full-schema handle on the snapshot pool. */
  snapshots: Database;
}

export interface PartnerLogbookAccess extends PartnerLogbookDatabases {
  snapshotAdmission: LogbookSnapshotAdmission;
  /** Cursor secrets, newest first: the partner OAuth secrets. */
  cursorSecrets: readonly PartnerSecret[];
  /** {@link logbookPageReader}, for the routes outside this folder. */
  pageReader(principal: PartnerApiPrincipal, onMetadata: (metadata: LogbookClimbMetadata) => void): LogbookPageReader;
  isConnectionEnded(error: unknown): boolean;
}

export function createPartnerLogbookAccess(
  databases: PartnerLogbookDatabases,
  cursorSecrets: readonly PartnerSecret[],
  admissionLimits: LogbookSnapshotAdmissionLimits = LOGBOOK_SNAPSHOT_ADMISSION_LIMITS,
): PartnerLogbookAccess {
  return {
    ...databases,
    snapshotAdmission: createLogbookSnapshotAdmission(admissionLimits),
    cursorSecrets,
    pageReader: logbookPageReader,
    isConnectionEnded: (error) => error instanceof PartnerConnectionEnded,
  };
}
