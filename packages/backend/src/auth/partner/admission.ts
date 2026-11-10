/**
 * Limits on how many requests wait for the partner pool. postgres.js queues
 * every query with no cap or deadline, so without this a flood of anonymous
 * authorize requests made a refresh wait over 3 s. Work past the cap is refused
 * at once instead of waiting.
 *
 * `/v1` work has two lanes. `api` is the shared one. One address group (an IPv4
 * address or an IPv6 /48, `apiLaneGroup`) may hold at most `apiPerAddressLimit`
 * of its places, running and waiting together. Its next request waits in
 * `api-overflow` instead, which runs on at most one of the two `/v1` permits,
 * has a short queue of its own and is served last. Routing, not refusal: a
 * burst from one address is still served, only slower, and that address can
 * never fill the lane everyone else uses, whether its tokens are valid or junk.
 */
export type PartnerAdmissionLane = 'token' | 'api' | 'api-overflow' | 'authorize';

export interface PartnerAdmissionLimits {
  /** At most this many requests run at once: the connections in the pool. */
  permits: number;
  /** Authorize is anonymous and browser-driven, so it may hold only this many. */
  authorizePermits: number;
  /**
   * `api` and `api-overflow` together may hold only this many, so a busy app's
   * polling always leaves a connection for its own refreshes.
   */
  apiPermits: number;
  /** One address group's share of the `api` lane, running and waiting together. */
  apiPerAddressLimit: number;
  /** Overflowing requests share this many of the `/v1` permits. */
  overflowApiPermits: number;
  /** Overflowing requests may queue only this deep. */
  overflowApiQueueLimit: number;
  queueLimitPerLane: number;
  queueDeadlineMs: number;
}

export interface PartnerAdmissionPermit {
  release(): void;
}

/** A permit from the partner gate, naming the lane it runs in. */
export interface PartnerLanePermit extends PartnerAdmissionPermit {
  /** `api-overflow` for `/v1` work past its address group's share. */
  readonly lane: PartnerAdmissionLane;
}

export interface PartnerAdmissionGate {
  /**
   * Resolves to a permit, or null when the queue is full or the deadline passed.
   * `api` work names the address group it comes from; a group already holding
   * its share of that lane is sent to `api-overflow`, and the permit says so.
   */
  acquire(lane: PartnerAdmissionLane, addressGroup?: string): Promise<PartnerLanePermit | null>;
}

interface AdmissionWaiter {
  lane: PartnerAdmissionLane;
  /** The group whose shared-lane place this waiter holds, if it holds one. */
  addressGroup: string | undefined;
  grant: (permit: PartnerLanePermit | null) => void;
  deadline: ReturnType<typeof setTimeout>;
}

/** Token work first, so no `/v1` or authorize flood can delay a refresh. Overflow waits last. */
const LANES_IN_PRIORITY_ORDER: readonly PartnerAdmissionLane[] = ['token', 'api', 'authorize', 'api-overflow'];

const isApiLane = (lane: PartnerAdmissionLane) => lane === 'api' || lane === 'api-overflow';

export function createPartnerAdmissionGate(limits: PartnerAdmissionLimits): PartnerAdmissionGate {
  let running = 0;
  const runningByLane: Record<PartnerAdmissionLane, number> = { token: 0, api: 0, 'api-overflow': 0, authorize: 0 };
  const laneCaps: Record<PartnerAdmissionLane, number> = {
    token: limits.permits,
    api: limits.apiPermits,
    'api-overflow': limits.overflowApiPermits,
    authorize: limits.authorizePermits,
  };
  const queueLimits: Record<PartnerAdmissionLane, number> = {
    token: limits.queueLimitPerLane,
    api: limits.queueLimitPerLane,
    'api-overflow': limits.overflowApiQueueLimit,
    authorize: limits.queueLimitPerLane,
  };
  const queues: Record<PartnerAdmissionLane, AdmissionWaiter[]> = {
    token: [],
    api: [],
    'api-overflow': [],
    authorize: [],
  };
  /** Places each address group holds in the `api` lane, running and waiting. */
  const sharedPlacesByGroup = new Map<string, number>();

  function takeSharedPlace(addressGroup: string) {
    sharedPlacesByGroup.set(addressGroup, (sharedPlacesByGroup.get(addressGroup) ?? 0) + 1);
  }

  function giveBackSharedPlace(addressGroup: string) {
    const remaining = (sharedPlacesByGroup.get(addressGroup) ?? 1) - 1;
    if (remaining <= 0) sharedPlacesByGroup.delete(addressGroup);
    else sharedPlacesByGroup.set(addressGroup, remaining);
  }

  const runningApi = () => runningByLane.api + runningByLane['api-overflow'];
  const canRun = (lane: PartnerAdmissionLane) =>
    running < limits.permits &&
    runningByLane[lane] < laneCaps[lane] &&
    (!isApiLane(lane) || runningApi() < limits.apiPermits);

  function startRunning(lane: PartnerAdmissionLane, addressGroup: string | undefined): PartnerLanePermit {
    running += 1;
    runningByLane[lane] += 1;
    let released = false;
    return {
      lane,
      release() {
        if (released) return;
        released = true;
        running -= 1;
        runningByLane[lane] -= 1;
        if (addressGroup !== undefined) giveBackSharedPlace(addressGroup);
        admitNext();
      },
    };
  }

  function admitNext() {
    for (const lane of LANES_IN_PRIORITY_ORDER) {
      while (queues[lane].length > 0 && canRun(lane)) {
        const waiter = queues[lane].shift() as AdmissionWaiter;
        clearTimeout(waiter.deadline);
        waiter.grant(startRunning(lane, waiter.addressGroup));
      }
    }
  }

  return {
    acquire(requestedLane, addressGroup) {
      // Decided and counted here, synchronously, so concurrent requests from one
      // group cannot all see a free share and pass together.
      let lane = requestedLane;
      let sharedPlaceOf: string | undefined;
      if (requestedLane === 'api' && addressGroup !== undefined) {
        if ((sharedPlacesByGroup.get(addressGroup) ?? 0) >= limits.apiPerAddressLimit) lane = 'api-overflow';
        else sharedPlaceOf = addressGroup;
      }

      if (canRun(lane) && queues[lane].length === 0) {
        if (sharedPlaceOf !== undefined) takeSharedPlace(sharedPlaceOf);
        return Promise.resolve(startRunning(lane, sharedPlaceOf));
      }
      // Refused without taking a place, so a refusal never counts against the group.
      if (queues[lane].length >= queueLimits[lane]) return Promise.resolve(null);
      if (sharedPlaceOf !== undefined) takeSharedPlace(sharedPlaceOf);
      return new Promise((resolve) => {
        const waiter: AdmissionWaiter = {
          lane,
          addressGroup: sharedPlaceOf,
          grant: resolve,
          deadline: setTimeout(() => {
            queues[lane].splice(queues[lane].indexOf(waiter), 1);
            if (sharedPlaceOf !== undefined) giveBackSharedPlace(sharedPlaceOf);
            resolve(null);
          }, limits.queueDeadlineMs),
        };
        waiter.deadline.unref();
        queues[lane].push(waiter);
      });
    },
  };
}
