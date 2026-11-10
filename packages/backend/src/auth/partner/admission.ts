/**
 * Limits on how many requests wait for the partner pool. postgres.js queues
 * every query with no cap or deadline, so without this a flood of anonymous
 * authorize requests made a refresh wait over 3 s. Work past the cap is refused
 * at once instead of waiting.
 *
 * `api-flagged` is where `/v1` requests from an address with many failed token
 * lookups wait. It is routing, not refusal: a valid token from that address is
 * still served there, only slower, and that address's junk can hold at most one
 * of the two `/v1` permits, so everyone else's `/v1` work keeps the other.
 */
export type PartnerAdmissionLane = 'token' | 'api' | 'api-flagged' | 'authorize';

export interface PartnerAdmissionLimits {
  /** At most this many requests run at once: the connections in the pool. */
  permits: number;
  /** Authorize is anonymous and browser-driven, so it may hold only this many. */
  authorizePermits: number;
  /**
   * `api` and `api-flagged` together may hold only this many, so a busy app's
   * polling always leaves a connection for its own refreshes.
   */
  apiPermits: number;
  /** Flagged addresses share this many of the `/v1` permits. */
  flaggedApiPermits: number;
  /** A flagged address's requests may queue only this deep. */
  flaggedApiQueueLimit: number;
  queueLimitPerLane: number;
  queueDeadlineMs: number;
}

export interface PartnerAdmissionPermit {
  release(): void;
}

export interface PartnerAdmissionGate {
  /** Resolves to a permit, or null when the queue is full or the deadline passed. */
  acquire(lane: PartnerAdmissionLane): Promise<PartnerAdmissionPermit | null>;
}

interface AdmissionWaiter {
  lane: PartnerAdmissionLane;
  grant: (permit: PartnerAdmissionPermit | null) => void;
  deadline: ReturnType<typeof setTimeout>;
}

/** Token work first, so no `/v1` or authorize flood can delay a refresh. A flagged address waits last. */
const LANES_IN_PRIORITY_ORDER: readonly PartnerAdmissionLane[] = ['token', 'api', 'authorize', 'api-flagged'];

const isApiLane = (lane: PartnerAdmissionLane) => lane === 'api' || lane === 'api-flagged';

export function createPartnerAdmissionGate(limits: PartnerAdmissionLimits): PartnerAdmissionGate {
  let running = 0;
  const runningByLane: Record<PartnerAdmissionLane, number> = { token: 0, api: 0, 'api-flagged': 0, authorize: 0 };
  const laneCaps: Record<PartnerAdmissionLane, number> = {
    token: limits.permits,
    api: limits.apiPermits,
    'api-flagged': limits.flaggedApiPermits,
    authorize: limits.authorizePermits,
  };
  const queueLimits: Record<PartnerAdmissionLane, number> = {
    token: limits.queueLimitPerLane,
    api: limits.queueLimitPerLane,
    'api-flagged': limits.flaggedApiQueueLimit,
    authorize: limits.queueLimitPerLane,
  };
  const queues: Record<PartnerAdmissionLane, AdmissionWaiter[]> = {
    token: [],
    api: [],
    'api-flagged': [],
    authorize: [],
  };

  const runningApi = () => runningByLane.api + runningByLane['api-flagged'];
  const canRun = (lane: PartnerAdmissionLane) =>
    running < limits.permits &&
    runningByLane[lane] < laneCaps[lane] &&
    (!isApiLane(lane) || runningApi() < limits.apiPermits);

  function startRunning(lane: PartnerAdmissionLane): PartnerAdmissionPermit {
    running += 1;
    runningByLane[lane] += 1;
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        running -= 1;
        runningByLane[lane] -= 1;
        admitNext();
      },
    };
  }

  function admitNext() {
    for (const lane of LANES_IN_PRIORITY_ORDER) {
      while (queues[lane].length > 0 && canRun(lane)) {
        const waiter = queues[lane].shift() as AdmissionWaiter;
        clearTimeout(waiter.deadline);
        waiter.grant(startRunning(lane));
      }
    }
  }

  return {
    acquire(lane) {
      if (canRun(lane) && queues[lane].length === 0) return Promise.resolve(startRunning(lane));
      if (queues[lane].length >= queueLimits[lane]) return Promise.resolve(null);
      return new Promise((resolve) => {
        const waiter: AdmissionWaiter = {
          lane,
          grant: resolve,
          deadline: setTimeout(() => {
            queues[lane].splice(queues[lane].indexOf(waiter), 1);
            resolve(null);
          }, limits.queueDeadlineMs),
        };
        waiter.deadline.unref();
        queues[lane].push(waiter);
      });
    },
  };
}
