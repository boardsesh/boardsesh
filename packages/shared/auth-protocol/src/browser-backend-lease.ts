import { z } from 'zod';
import { browserBindingCursorSchema } from './browser-coordinator-v1';

/** The source bearer and private binding token never enter this public scope. */
export const browserBackendLeaseOwnerSchema = z
  .object({
    userId: z.string().min(1).max(1024),
    authSessionId: z.string().min(1).max(1024),
    generation: z.number().int().min(0).max(2_147_483_647),
    cursor: browserBindingCursorSchema.refine((cursor) => cursor.version > 0),
  })
  .strict();
export type BrowserBackendLeaseOwner = z.infer<typeof browserBackendLeaseOwnerSchema>;
export const browserBackendLeaseReplySchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('admitted'),
      token: z
        .string()
        .max(4096)
        .regex(/^bsbd1_[A-Za-z0-9_-]+$/),
      usableForMs: z.number().int().positive().max(120_000),
      owner: browserBackendLeaseOwnerSchema,
    })
    .strict(),
  z.object({ status: z.enum(['denied', 'conflict', 'unavailable']) }).strict(),
]);
export type BrowserBackendLeaseReply = z.infer<typeof browserBackendLeaseReplySchema>;
export type BrowserBackendLease = Extract<BrowserBackendLeaseReply, { status: 'admitted' }>;
export type BrowserBackendLeaseResult = BrowserBackendLeaseReply | { readonly status: 'superseded' };

export function sameBrowserBackendLeaseOwner(left: BrowserBackendLeaseOwner, right: BrowserBackendLeaseOwner): boolean {
  return (
    left.userId === right.userId &&
    left.authSessionId === right.authSessionId &&
    left.generation === right.generation &&
    left.cursor.bindingId === right.cursor.bindingId &&
    left.cursor.version === right.cursor.version
  );
}
function captureOwner(input: BrowserBackendLeaseOwner): Readonly<BrowserBackendLeaseOwner> {
  const owner = browserBackendLeaseOwnerSchema.parse(input);
  return Object.freeze({ ...owner, cursor: Object.freeze(owner.cursor) });
}
type CachedLease = { readonly token: string; readonly deadline: number; readonly refreshAt: number };
type Flight = {
  readonly revision: number;
  readonly controller: AbortController;
  readonly promise: Promise<BrowserBackendLeaseResult>;
};

/** A process-memory credential holder. I/O and monotonic time are injected;
 * subscribers see metadata only, never a bearer. No storage/channel is used.
 * Its fetch must be a cookie-free reader; this is not a cookie coordinator. */
export function createBrowserBackendLeaseManager(options: {
  readonly now: () => number;
  readonly fetchLease: (owner: Readonly<BrowserBackendLeaseOwner>, signal: AbortSignal) => Promise<unknown>;
  readonly schedule: (callback: () => void, milliseconds: number) => () => void;
  readonly timeoutMs?: number;
  readonly refreshLeadMs?: number;
}) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const refreshLeadMs = options.refreshLeadMs ?? 10_000;
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 30_000 ||
    !Number.isFinite(refreshLeadMs) ||
    refreshLeadMs < 0 ||
    refreshLeadMs > 30_000
  )
    throw new Error('BROWSER_BACKEND_LEASE_CONFIGURATION_INVALID');
  const now = options.now;
  const fetchLease = options.fetchLease;
  const schedule = options.schedule;
  let lastClock = -Infinity;
  const clock = () => {
    const current = now();
    if (!Number.isFinite(current) || current < 0 || current < lastClock)
      throw new Error('BROWSER_BACKEND_LEASE_CLOCK_INVALID');
    lastClock = current;
    return current;
  };
  let owner: Readonly<BrowserBackendLeaseOwner> | null = null;
  let revision = 0;
  let cached: CachedLease | undefined;
  let flight: Flight | undefined;
  let closed = false;
  const receipts = new WeakMap<
    object,
    { readonly revision: number; readonly owner: BrowserBackendLeaseOwner; readonly deadline: number }
  >();
  let snapshot: Readonly<{
    owner: Readonly<BrowserBackendLeaseOwner> | null;
    revision: number;
    refreshing: boolean;
    closed: boolean;
  }> = Object.freeze({ owner, revision, refreshing: false, closed });
  const listeners = new Set<() => void>();
  const notify = () => {
    const refreshing = flight !== undefined;
    if (
      snapshot.owner === owner &&
      snapshot.revision === revision &&
      snapshot.refreshing === refreshing &&
      snapshot.closed === closed
    )
      return;
    snapshot = Object.freeze({ owner, revision, refreshing, closed });
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* One view cannot prevent the others invalidating. */
      }
    }
  };
  const matches = (expected: BrowserBackendLeaseOwner) =>
    !closed && owner !== null && sameBrowserBackendLeaseOwner(owner, expected);
  const discard = () => {
    revision += 1;
    cached = undefined;
    const previous = flight;
    flight = undefined;
    previous?.controller.abort();
  };
  const existing = (expected: BrowserBackendLeaseOwner): BrowserBackendLeaseReply | undefined => {
    if (!matches(expected) || !cached) return;
    const remaining = Math.floor(cached.deadline - clock());
    if (remaining <= 0) {
      cached = undefined;
      return;
    }
    const result = Object.freeze({
      status: 'admitted' as const,
      token: cached.token,
      usableForMs: remaining,
      owner: owner!,
    });
    receipts.set(result, { revision, owner: owner!, deadline: cached.deadline });
    return result;
  };
  return {
    /** Only a newly confirmed central-reader/coordinator observation sets scope. */
    setOwner(next: BrowserBackendLeaseOwner | null): void {
      if (closed) return;
      const captured = next === null ? null : captureOwner(next);
      if (owner === null ? captured === null : captured !== null && sameBrowserBackendLeaseOwner(owner, captured))
        return;
      discard();
      owner = captured;
      notify();
    },
    /** Invalidate only this observed owner, never a later account or login. */
    invalidate(expected: BrowserBackendLeaseOwner): void {
      if (!matches(expected)) return;
      discard();
      notify();
    },
    async acquire(expectedInput: BrowserBackendLeaseOwner): Promise<BrowserBackendLeaseResult> {
      let expected: Readonly<BrowserBackendLeaseOwner>;
      try {
        expected = captureOwner(expectedInput);
      } catch {
        return { status: 'unavailable' };
      }
      if (!matches(expected)) return { status: 'superseded' };
      try {
        const live = existing(expected);
        if (live && cached && clock() < cached.refreshAt) return live;
        if (flight?.revision === revision) return flight.promise;
        const capturedRevision = revision;
        const controller = new AbortController();
        const startedAt = clock();
        let cancelTimeout: (() => void) | undefined;
        const promise = (async (): Promise<BrowserBackendLeaseResult> => {
          try {
            const timeout = new Promise<never>((_resolve, reject) => {
              cancelTimeout = schedule(() => {
                controller.abort();
                reject(new Error('BROWSER_BACKEND_LEASE_TIMEOUT'));
              }, timeoutMs);
            });
            const reply = browserBackendLeaseReplySchema.parse(
              await Promise.race([fetchLease(expected, controller.signal), timeout]),
            );
            if (revision !== capturedRevision || !matches(expected)) return { status: 'superseded' };
            if (reply.status !== 'admitted') {
              if (reply.status !== 'unavailable') {
                cached = undefined;
                revision += 1;
              }
              return reply.status === 'unavailable' ? (existing(expected) ?? reply) : reply;
            }
            if (!sameBrowserBackendLeaseOwner(reply.owner, expected)) {
              cached = undefined;
              revision += 1;
              return { status: 'conflict' };
            }
            const receivedAt = clock();
            const remaining = reply.usableForMs - (receivedAt - startedAt);
            if (remaining < 1) {
              cached = undefined;
              revision += 1;
              return { status: 'unavailable' };
            }
            const deadline = receivedAt + remaining;
            cached = Object.freeze({
              token: reply.token,
              deadline,
              refreshAt: deadline - Math.min(refreshLeadMs, remaining / 4),
            });
            return existing(expected) ?? { status: 'unavailable' };
          } catch {
            if (revision !== capturedRevision || !matches(expected)) return { status: 'superseded' };
            try {
              return existing(expected) ?? { status: 'unavailable' };
            } catch {
              cached = undefined;
              return { status: 'unavailable' };
            }
          } finally {
            try {
              cancelTimeout?.();
            } catch {
              /* Cleanup cannot republish or reject a settled credential result. */
            }
          }
        })();
        const created = { revision: capturedRevision, controller, promise };
        flight = created;
        notify();
        void promise.then(() => {
          if (flight === created) {
            flight = undefined;
            notify();
          }
        });
        return promise;
      } catch {
        cached = undefined;
        return { status: 'unavailable' };
      }
    },
    /** Recheck the ORIGINAL returned result after every await and immediately
     * before attaching a bearer or publishing response/cache state. Copies or
     * caller-constructed metadata cannot acquire this process-local receipt. */
    isCurrent(result: unknown): result is BrowserBackendLease {
      if (result === null || typeof result !== 'object') return false;
      const receipt = receipts.get(result);
      if (!receipt || receipt.revision !== revision || !matches(receipt.owner)) return false;
      try {
        return clock() < receipt.deadline;
      } catch {
        return false;
      }
    },
    /** Metadata for views; the bearer stays outside query-cache persistence. */
    getSnapshot: () => snapshot,
    subscribe(listener: () => void): () => void {
      if (closed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose(): void {
      if (closed) return;
      discard();
      closed = true;
      owner = null;
      notify();
      listeners.clear();
    },
  };
}
