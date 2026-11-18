import {
  AUTH_ADMISSION_BATCH_SIZE,
  AUTH_ADMISSION_RESPONSE_DEADLINE_MS,
  AuthAdmissionUnavailableError,
} from './admission-read-runner';

/**
 * Reads this coalescer runs at once: one per admission connection. A third read
 * would only queue behind them, where it can use up the whole deadline. Callers
 * wait here instead, where one that outlives the deadline is refused before any
 * read starts. The WebSocket sweep calls the runner directly. During a stall,
 * timed-out reads can still hold every runner slot.
 */
export const MAX_CONCURRENT_COALESCED_ADMISSION_READS = 2;

/** Distinct users allowed to wait for a read before new callers are refused. */
export const MAX_WAITING_ADMISSION_USERS = 1024;

/**
 * Read slots that several coalescers share, so the reads they start together
 * never exceed `MAX_CONCURRENT_COALESCED_ADMISSION_READS`. When a read ends,
 * the waiting coalescers are woken in turn, starting after the one woken
 * first last time, so a burst on one cannot starve the other.
 */
interface AdmissionReadSlots {
  inFlight: number;
  readonly members: Array<{ readonly hasWaiters: () => boolean; readonly schedule: () => void }>;
  turn: number;
}

function createAdmissionReadSlots(): AdmissionReadSlots {
  return { inFlight: 0, members: [], turn: 0 };
}

/**
 * Named slot groups. `per-request` is the one every request-path admission
 * read uses: the account read of the app and web credentials, and the browser
 * access token's session read (#7596, B3a). The sweep calls the runner directly.
 */
const SLOT_GROUPS = new Map<AdmissionSlotGroup, AdmissionReadSlots>();

export type AdmissionSlotGroup = 'per-request';

function groupSlots(group: AdmissionSlotGroup): AdmissionReadSlots {
  const existing = SLOT_GROUPS.get(group);
  if (existing) return existing;
  const created = createAdmissionReadSlots();
  SLOT_GROUPS.set(group, created);
  return created;
}

function wakeWaitingMembers(slots: AdmissionReadSlots): void {
  const count = slots.members.length;
  for (let offset = 0; offset < count; offset += 1) {
    const member = slots.members[(slots.turn + offset) % count];
    if (member.hasWaiters()) member.schedule();
  }
  if (count > 0) slots.turn = (slots.turn + 1) % count;
}

type AdmissionWaiter<Answer> = {
  enqueuedAt: number;
  resolve: (answer: Answer | undefined) => void;
  reject: (error: unknown) => void;
};

/**
 * Callers share primary reads, so a burst of requests or sockets costs a few
 * read slots rather than one slot each. While every read is in flight, callers
 * wait for the next one instead of being refused, up to the response deadline.
 *
 * A caller only ever joins a read that has not started, so its answer is never
 * older than its question. This coalesces work; it is not a cache.
 *
 * The read answers for each active user it found. A user it has no answer for
 * (deleted or missing) resolves to undefined. The key need not be a user id:
 * the browser session read keys by session id.
 *
 * Coalescers in one `slotGroup` share its two read slots.
 */
export function createAdmissionCoalescer<Answer>(
  readAnswers: (userIds: readonly string[]) => Promise<ReadonlyMap<string, Answer>>,
  slotGroup?: AdmissionSlotGroup,
): (userId: string) => Promise<Answer | undefined> {
  const waitersByUserId = new Map<string, AdmissionWaiter<Answer>[]>();
  // Without a group, this coalescer has its own two slots, as before.
  const sharedSlots = slotGroup === undefined ? createAdmissionReadSlots() : groupSlots(slotGroup);
  let isFlushScheduled = false;

  function scheduleFlush() {
    if (isFlushScheduled) return;
    isFlushScheduled = true;
    setImmediate(flushWaiters);
  }

  /** Removes up to one batch of waiters, refusing any that outlived the deadline. */
  function claimNextBatch(): Map<string, AdmissionWaiter<Answer>[]> {
    const claimedWaiters = new Map<string, AdmissionWaiter<Answer>[]>();
    const oldestAllowed = performance.now() - AUTH_ADMISSION_RESPONSE_DEADLINE_MS;
    for (const [userId, waiters] of waitersByUserId) {
      if (claimedWaiters.size === AUTH_ADMISSION_BATCH_SIZE) break;
      waitersByUserId.delete(userId);
      const liveWaiters = waiters.filter((waiter) => {
        if (waiter.enqueuedAt > oldestAllowed) return true;
        waiter.reject(new AuthAdmissionUnavailableError());
        return false;
      });
      if (liveWaiters.length > 0) claimedWaiters.set(userId, liveWaiters);
    }
    return claimedWaiters;
  }

  function flushWaiters() {
    isFlushScheduled = false;
    while (sharedSlots.inFlight < MAX_CONCURRENT_COALESCED_ADMISSION_READS && waitersByUserId.size > 0) {
      const claimedWaiters = claimNextBatch();
      if (claimedWaiters.size === 0) continue;
      sharedSlots.inFlight += 1;
      void readAnswers([...claimedWaiters.keys()])
        .then(
          (answers) => {
            for (const [userId, waiters] of claimedWaiters) {
              for (const waiter of waiters) waiter.resolve(answers.get(userId));
            }
          },
          (error: unknown) => {
            for (const waiters of claimedWaiters.values()) {
              for (const waiter of waiters) waiter.reject(error);
            }
          },
        )
        .finally(() => {
          sharedSlots.inFlight -= 1;
          wakeWaitingMembers(sharedSlots);
        });
    }
  }
  sharedSlots.members.push({ hasWaiters: () => waitersByUserId.size > 0, schedule: scheduleFlush });

  return (userId) =>
    new Promise<Answer | undefined>((resolve, reject) => {
      const waiters = waitersByUserId.get(userId);
      if (!waiters && waitersByUserId.size >= MAX_WAITING_ADMISSION_USERS) {
        reject(new AuthAdmissionUnavailableError());
        return;
      }
      const waiter = { enqueuedAt: performance.now(), resolve, reject };
      if (waiters) waiters.push(waiter);
      else waitersByUserId.set(userId, [waiter]);
      scheduleFlush();
    });
}
