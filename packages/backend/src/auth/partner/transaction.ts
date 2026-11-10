import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import { logger } from '../../utils/logger';
import { getPostgresErrorCode } from '../../utils/postgres-errors';
import type { DedicatedPoolOverrides } from '@boardsesh/db/client';
import type { PartnerDatabase } from './tables';

/** Partner OAuth runs on a pool of its own so it cannot starve GraphQL (the shared pool defaults to 5). */
export const PARTNER_POOL_MAX = 3;

/**
 * Each partner transaction sets this for itself. The pool sends it at connect
 * too, so a transaction opened on the pool any other way gets the same limit
 * instead of the process-wide 60 s.
 */
export const PARTNER_IDLE_IN_TRANSACTION_TIMEOUT_MS = 10_000;

const LOCK_TIMEOUT = '2s';
const STATEMENT_TIMEOUT = '5s';
const IDLE_IN_TRANSACTION_TIMEOUT = `${PARTNER_IDLE_IN_TRANSACTION_TIMEOUT_MS}ms`;
const BUSY_RETRY_AFTER_SECONDS = '2';

/** Startup parameters for the partner and logbook snapshot pools, passed to `createDedicatedPool`. */
export function partnerPoolOverrides(): DedicatedPoolOverrides {
  return { connection: { idle_in_transaction_session_timeout: PARTNER_IDLE_IN_TRANSACTION_TIMEOUT_MS } };
}

/** lock_not_available, query_canceled (statement_timeout), deadlock_detected: all retryable. */
const DATABASE_BUSY_CODES = new Set(['55P03', '57014', '40P01']);

/** What the consent guard established about this request's consent link. */
export interface PartnerConsentDecision {
  /** The climber pressed Allow. */
  approved: boolean;
  /**
   * The connection generation the link was opened against, 0 when there was no
   * connection yet. Still current when the guard checked; the code is issued only
   * if it is still current then too.
   */
  generation: number;
}

export interface PartnerRequestState {
  /** A lock wait or statement timeout aborted this request's transaction. */
  databaseBusy: boolean;
  /** The climber approved consent in this request, so a disconnected connection may reconnect. */
  consentApproved: boolean;
  /** Set only by the consent guard, after it has checked and spent the climber's consent link. */
  consent: PartnerConsentDecision | null;
  /** The connection whose code this token request redeems, set once the fence holds its lock. */
  redemption: { userId: string; clientId: string } | null;
}

interface ActivePartnerTransaction {
  transaction: PartnerDatabase;
  state: PartnerRequestState;
}

const activeTransaction = new AsyncLocalStorage<ActivePartnerTransaction>();

/** A provider can turn a thrown error into a Response before the transaction sees it. */
export class PartnerResponseRollback extends Error {
  constructor(readonly response: Response) {
    super('Roll back the failed partner OAuth request');
  }
}

/**
 * A refusal that must leave nothing behind, such as a connection cap reached
 * after the provider has already written the consent and the code. Rolls the
 * request back and answers with `response`, logged as an outcome, not a failure.
 */
export class PartnerRefusal extends PartnerResponseRollback {}

export function rejectPartnerServerFailure(response: Response): Response {
  if (response.status >= 500) throw new PartnerResponseRollback(response);
  // An OAuth invalid_grant may need to commit its replay cleanup.
  return response;
}

export function isPartnerDatabaseBusy(error: unknown): boolean {
  const code = getPostgresErrorCode(error);
  return code !== undefined && DATABASE_BUSY_CODES.has(code);
}

/** The adapter calls this because stock endpoints can turn a query failure into a generic 500. */
export function recordPartnerRequestError(error: unknown): void {
  const active = activeTransaction.getStore();
  if (active && isPartnerDatabaseBusy(error)) active.state.databaseBusy = true;
}

export function partnerBusyResponse(): Response {
  return Response.json(
    { error: 'temporarily_unavailable', error_description: 'The server is busy. Try again shortly.' },
    { status: 503, headers: { 'cache-control': 'no-store', 'retry-after': BUSY_RETRY_AFTER_SECONDS } },
  );
}

/**
 * The transaction the current request runs in. Guards call this rather than the
 * pool: a query outside the request's transaction would see other locks and,
 * with a pool of three, could wait forever for a connection this request holds.
 */
export function currentPartnerTransaction(): ActivePartnerTransaction {
  const active = activeTransaction.getStore();
  if (!active) throw new Error('A partner OAuth guard ran outside a partner request transaction.');
  return active;
}

/**
 * A Drizzle handle that follows the current request's transaction. The provider
 * calls `ctx.context.adapter` directly, so `runWithTransaction` alone would not
 * enrol it; pointing the adapter at this handle does, for one long-lived authority.
 */
export function createPartnerDatabaseHandle(root: PartnerDatabase): PartnerDatabase {
  return new Proxy(root, {
    get(target, property) {
      const current = activeTransaction.getStore()?.transaction ?? target;
      const member: unknown = Reflect.get(current, property);
      return typeof member === 'function' ? member.bind(current) : member;
    },
  });
}

export async function runInPartnerTransaction<Result>(
  root: PartnerDatabase,
  work: (transaction: PartnerDatabase, state: PartnerRequestState) => Promise<Result>,
): Promise<Result> {
  const state: PartnerRequestState = { databaseBusy: false, consentApproved: false, consent: null, redemption: null };
  return root.transaction(async (transaction) => {
    // Written to pg_settings for this transaction only. SET cannot take bind
    // parameters, and these are constants, so this stays a single round trip.
    await transaction.execute(
      sql`select set_config('lock_timeout', ${LOCK_TIMEOUT}, true),
                 set_config('statement_timeout', ${STATEMENT_TIMEOUT}, true),
                 set_config('idle_in_transaction_session_timeout', ${IDLE_IN_TRANSACTION_TIMEOUT}, true)`,
    );
    return activeTransaction.run({ transaction, state }, () => work(transaction, state));
  });
}

export interface PartnerRequestOptions {
  /**
   * False only for a request that cannot reach a fence: discovery, the error
   * page, and an authorize with no session cookie. A guard that asks for a
   * transaction anyway throws, so a mistake here answers 500 rather than running
   * unfenced.
   */
  transaction?: boolean;
  /** Carried onto failure logs. Never tokens or codes. */
  logContext?: { requestId?: string; clientId?: string };
}

/**
 * One request, one transaction. A protocol 4xx commits so replay cleanup
 * persists; a 5xx rolls back so a failed mint leaves nothing behind; a lock
 * timeout rolls back and answers 503, never invalid_grant.
 */
export async function handlePartnerRequest(
  root: PartnerDatabase,
  request: Request,
  handler: (request: Request) => Promise<Response>,
  { transaction = true, logContext }: PartnerRequestOptions = {},
): Promise<Response> {
  let requestState: PartnerRequestState | undefined;
  try {
    if (!transaction) return await handler(request);
    return await runInPartnerTransaction(root, async (_transaction, state) => {
      requestState = state;
      return rejectPartnerServerFailure(await handler(request));
    });
  } catch (error) {
    if (requestState?.databaseBusy || isPartnerDatabaseBusy(error)) return partnerBusyResponse();
    if (error instanceof PartnerRefusal) {
      logger.info('Partner OAuth request refused', { ...logContext, status: error.response.status });
      return error.response;
    }
    if (error instanceof PartnerResponseRollback) {
      logger.error('Partner OAuth request failed', { ...logContext, status: error.response.status });
      return error.response;
    }
    // Name and database code only: Drizzle's error text carries the query parameters.
    logger.error('Partner OAuth request failed', {
      ...logContext,
      errorName: error instanceof Error ? error.name : 'unknown',
      postgresCode: getPostgresErrorCode(error),
    });
    return new Response(null, { status: 500 });
  }
}
