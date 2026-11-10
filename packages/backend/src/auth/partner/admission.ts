/**
 * Limits on how many requests wait for the partner pool. postgres.js queues
 * every query with no cap or deadline, so without this a flood of anonymous
 * authorize requests made a refresh wait over 3 s. Work past the cap is refused
 * at once instead of waiting.
 */
export type PartnerAdmissionLane = 'token' | 'api' | 'authorize';

export interface PartnerAdmissionLimits {
  /** At most this many requests run at once: the connections in the pool. */
  permits: number;
  /** Authorize is anonymous and browser-driven, so it may hold only this many. */
  authorizePermits: number;
  /**
   * `/v1` requests may hold only this many, so a busy app's polling always
   * leaves a connection for its own refreshes.
   */
  apiPermits: number;
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

/** Token work first, so neither a `/v1` nor an authorize flood can delay a refresh. */
const LANES_IN_PRIORITY_ORDER: readonly PartnerAdmissionLane[] = ['token', 'api', 'authorize'];

export function createPartnerAdmissionGate(limits: PartnerAdmissionLimits): PartnerAdmissionGate {
  let running = 0;
  const runningByLane: Record<PartnerAdmissionLane, number> = { token: 0, api: 0, authorize: 0 };
  const laneCaps: Record<PartnerAdmissionLane, number> = {
    token: limits.permits,
    api: limits.apiPermits,
    authorize: limits.authorizePermits,
  };
  const queues: Record<PartnerAdmissionLane, AdmissionWaiter[]> = { token: [], api: [], authorize: [] };

  const canRun = (lane: PartnerAdmissionLane) => running < limits.permits && runningByLane[lane] < laneCaps[lane];

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
      if (queues[lane].length >= limits.queueLimitPerLane) return Promise.resolve(null);
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
