/**
 * Limits on how many requests wait for the partner pool. postgres.js queues
 * every query with no cap or deadline, so without this a flood of anonymous
 * authorize requests made a refresh wait over 3 s. Work past the cap is refused
 * at once instead of waiting.
 */
export type PartnerAdmissionLane = 'token' | 'authorize';

export interface PartnerAdmissionLimits {
  /** At most this many requests run at once: the connections in the pool. */
  permits: number;
  /** Authorize is anonymous and browser-driven, so it may hold only this many. */
  authorizePermits: number;
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

export function createPartnerAdmissionGate(limits: PartnerAdmissionLimits): PartnerAdmissionGate {
  let running = 0;
  let authorizeRunning = 0;
  const queues: Record<PartnerAdmissionLane, AdmissionWaiter[]> = { token: [], authorize: [] };

  const canRun = (lane: PartnerAdmissionLane) =>
    running < limits.permits && (lane !== 'authorize' || authorizeRunning < limits.authorizePermits);

  function startRunning(lane: PartnerAdmissionLane): PartnerAdmissionPermit {
    running += 1;
    if (lane === 'authorize') authorizeRunning += 1;
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        running -= 1;
        if (lane === 'authorize') authorizeRunning -= 1;
        admitNext();
      },
    };
  }

  /** Token work first, so an authorize flood cannot delay a refresh. */
  function admitNext() {
    for (const lane of ['token', 'authorize'] as const) {
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
