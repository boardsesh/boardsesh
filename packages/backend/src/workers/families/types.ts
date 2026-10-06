import type { ZodType } from 'zod';
import type { DbInstance } from '@boardsesh/db/client';
import type {
  BackgroundJobFamily as BackgroundJobFamilyName,
  BackgroundWorkerRole,
} from '@boardsesh/db/background-jobs';
import type { BackgroundJobTransaction } from '@boardsesh/db/queries';

/**
 * What a family's `execute` gets. Three database paths, each with one job:
 *
 * - `transaction(callback)`: every WRITE. It runs under the attempt fence, so a
 *   batch commits only while this attempt still owns the run and its lease.
 * - `database`: unfenced READS only (planning a batch, loading a cursor). A write
 *   here escapes the fence and can land after a newer attempt has taken over.
 * - Provider HTTP goes through neither: never hold a fence open across a
 *   network call.
 */
export type BackgroundJobContext = {
  runId: string;
  family: BackgroundJobFamilyName;
  signal: AbortSignal;
  /**
   * When this attempt's pg-boss lease ends (epoch ms). `signal` aborts at it;
   * a family that wants to stop cleanly before then (and record why) derives
   * its own, earlier deadline from this.
   */
  expiresAt: number;
  database: DbInstance;
  transaction<T>(callback: (transaction: BackgroundJobTransaction) => Promise<T>): Promise<T>;
  /**
   * The same attempt fence as `transaction`, without its abort checks. Only
   * for recording why an attempt failed after `signal` has already fired from
   * a worker shutdown or a lost attempt (a failed heartbeat): `transaction`
   * would refuse that write, and a family that tracks its own state in a row
   * would leave it mid-flight.
   *
   * It does NOT cover a lease timeout. That abort fires at `startedOn +
   * expireInSeconds`, the moment the fence's own active-attempt check stops
   * passing, so the fence refuses the write too. A family that needs a final
   * state after a timeout has to recover it some other way (`spray-wall-art`
   * reads a pending row past its run deadline as failed and re-queues it).
   * The fence also refuses once another attempt owns the run. Optional so a
   * hand-built test context need not supply it; fall back to `transaction`.
   */
  transactionAfterAbort?<T>(callback: (transaction: BackgroundJobTransaction) => Promise<T>): Promise<T>;
  /**
   * Queue another family's run inside one of this run's transactions, so the
   * run commits (or rolls back) with that batch. Same semantics as
   * `enqueueBackgroundJobOn`, on this worker's queue client.
   */
  enqueue(
    transaction: BackgroundJobTransaction,
    input: {
      family: string;
      payload: unknown;
      role?: BackgroundWorkerRole;
      singletonKey?: string;
      startAfterSeconds?: number;
    },
  ): Promise<{ runId: string; alreadyQueued: boolean }>;
};

/** Per-job pg-boss options plus the ledger deadline, applied at `send()` time. */
export type BackgroundJobFamilyOptions = {
  /** One attempt's lease. pg-boss caps this at 24 h. */
  expireInSeconds: number;
  retryLimit: number;
  retryDelay: number;
  retryBackoff: boolean;
  retryDelayMax: number;
  /** Absolute deadline for the whole run, across every retry (`deadline_at`). */
  deadlineSeconds: number;
  /** pg-boss heartbeat window; must be at least 10. */
  heartbeatSeconds: number;
  /** pg-boss fetch priority on the role's queue: higher runs first. Defaults to 0. */
  priority?: number;
};

export type BackgroundJobScheduleRequest<Payload> = {
  payload: Payload;
  singletonKey?: string;
  /** Overrides the schedule's role for this one job. */
  role?: BackgroundWorkerRole;
};

export type BackgroundJobSchedule<Payload> = {
  /** Stable within the family; the pg-boss schedule key is `<family>/<key>`. */
  key: string;
  cron: string;
  /** Defaults to UTC. */
  tz?: string;
  /**
   * The role its jobs run on. Required when the family serves more than one
   * role; `startBatchSchedules` refuses to register the schedule without it.
   */
  role?: BackgroundWorkerRole;
  /** Runs in the backend on each tick. Return one entry per job to enqueue. */
  fanOut(database: DbInstance): Promise<Array<BackgroundJobScheduleRequest<Payload>>>;
};

/**
 * A family module. Methods use method syntax on purpose: it keeps a
 * `BackgroundJobFamilyModule<ProbePayload>` assignable to the registry's
 * `BackgroundJobFamilyModule<unknown>`, and the registry only ever calls
 * `execute`/`singletonKey` with a payload the same module's schema produced.
 */
export type BackgroundJobFamilyModule<Payload = unknown> = {
  name: BackgroundJobFamilyName;
  /** The worker roles that may run this family. Most families have exactly one. */
  roles: readonly BackgroundWorkerRole[];
  options: BackgroundJobFamilyOptions;
  payload: ZodType<Payload>;
  /** Dedup key on the stately queue. Omit it and every run is its own key. */
  singletonKey?(payload: Payload): string;
  schedules?: ReadonlyArray<BackgroundJobSchedule<Payload>>;
  execute(context: BackgroundJobContext, payload: Payload): Promise<void>;
};

/**
 * Throw from `execute` to record a bounded, credential-free `error_code`.
 * `retryable: false` ends the run now instead of spending pg-boss retries on a
 * failure no retry can fix. Any other thrown error records `ATTEMPT_FAILED`.
 */
/**
 * A payload the family's schema refuses, at enqueue. Its message stays the
 * bare `INVALID_PAYLOAD` code that callers log and summarise; code that needs
 * to tell it apart from other failures checks the class, never the message.
 */
export class InvalidJobPayloadError extends Error {
  readonly code = 'INVALID_PAYLOAD';

  constructor() {
    super('INVALID_PAYLOAD');
    this.name = 'InvalidJobPayloadError';
  }
}

export class BackgroundJobError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, options: { retryable?: boolean } = {}) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) throw new Error('INVALID_ERROR_CODE');
    super(code);
    this.name = 'BackgroundJobError';
    this.code = code;
    this.retryable = options.retryable ?? true;
  }
}
