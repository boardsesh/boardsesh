/**
 * Limits on how many requests wait for the partner pool. postgres.js queues
 * every query with no cap or deadline, so without this a flood of anonymous
 * authorize requests made a refresh wait over 3 s. Work past the cap is refused
 * at once instead of waiting.
 *
 * `/v1` work has two lanes. `api` is the shared one. One address group (an IPv4
 * address, an IPv6 /48 or a Cloudflare Worker zone, `apiLaneGroup`) may hold at
 * most `apiPerAddressLimit` of its places, running and waiting together. Its
 * next request waits in `api-overflow` instead, which runs on at most one of
 * the two `/v1` permits, has a queue of its own, is served last, and also holds
 * at most `overflowApiPerAddressLimit` places per group. Routing, not refusal:
 * a burst from one address is still served, only slower.
 *
 * A few groups at their share can still fill a lane's queue between them (3 x
 * 8 is more than the shared lane's 18 places). So when a lane's queue is full,
 * the newest waiter of the group holding the most places in that lane gives its
 * place up, but only to a group that would still hold fewer places than it
 * after taking one: equals never trade places back and forth. A waiter that
 * gives up a shared place moves to overflow when its group has room there, and
 * is refused otherwise. A group with nothing in flight therefore always gets a
 * place while any other group holds two or more waiting ones.
 *
 * Every Cloudflare Worker zone is its own group, but the zone header is the
 * Worker's to write, so all zones behind the Worker egress address also share a
 * ceiling in each lane (`apiPerEgressLimit`, `overflowApiPerEgressLimit`), and
 * the fairness rule weighs a Worker request by that shared count. Forged zones
 * can fill the ceiling, never the places left for everyone else. Inside a full
 * ceiling the same rule runs among the zones: the zone holding the most places
 * gives one up to a zone that would hold fewer, so junk zones cannot shut out
 * an honest one.
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
  /** One address group's share of `api-overflow`, running and waiting together. */
  overflowApiPerAddressLimit: number;
  /** Every Worker zone behind one egress address together, in the `api` lane. */
  apiPerEgressLimit: number;
  /** Every Worker zone behind one egress address together, in `api-overflow`. */
  overflowApiPerEgressLimit: number;
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
   * `api` work names the address group it comes from, and for a Cloudflare
   * Worker the egress address its zones share; a group (or egress) already
   * holding its share of that lane is sent to `api-overflow`, and the permit
   * says so.
   */
  acquire(lane: PartnerAdmissionLane, addressGroup?: string, egressGroup?: string): Promise<PartnerLanePermit | null>;
}

interface AdmissionWaiter {
  /** Where it waits now. A shared waiter that gives up its place moves to overflow. */
  lane: PartnerAdmissionLane;
  /** The places this waiter holds in `lane`: its group's, and its Worker egress's (`placeKeys`). */
  places: readonly string[];
  grant: (permit: PartnerLanePermit | null) => void;
  deadline: ReturnType<typeof setTimeout>;
}

/** Token work first, so no `/v1` or authorize flood can delay a refresh. Overflow waits last. */
const LANES_IN_PRIORITY_ORDER: readonly PartnerAdmissionLane[] = ['token', 'api', 'authorize', 'api-overflow'];

type ApiLane = 'api' | 'api-overflow';
const isApiLane = (lane: PartnerAdmissionLane): lane is ApiLane => lane === 'api' || lane === 'api-overflow';

/** Marks a Worker egress's count, so it never mixes with an address group's. */
const EGRESS_PLACE_PREFIX = 'egress:';

/** The counts one request holds a place in: its group, then its Worker egress. */
function placeKeys(addressGroup: string | undefined, egressGroup: string | undefined): readonly string[] {
  if (addressGroup === undefined) return [];
  return egressGroup === undefined ? [addressGroup] : [addressGroup, `${EGRESS_PLACE_PREFIX}${egressGroup}`];
}

/** What fairness weighs a request by: the Worker egress's count when there is one, else its group's. */
const fairnessKey = (places: readonly string[]): string | undefined => places[places.length - 1];

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
  /** Places each address group and Worker egress holds in each `/v1` lane, running and waiting. */
  const placesByKey: Record<ApiLane, Map<string, number>> = { api: new Map(), 'api-overflow': new Map() };
  const shareOf = (lane: ApiLane, key: string) => {
    if (key.startsWith(EGRESS_PLACE_PREFIX)) {
      return lane === 'api' ? limits.apiPerEgressLimit : limits.overflowApiPerEgressLimit;
    }
    return lane === 'api' ? limits.apiPerAddressLimit : limits.overflowApiPerAddressLimit;
  };

  const placesOf = (lane: ApiLane, key: string) => placesByKey[lane].get(key) ?? 0;
  const hasShareLeft = (lane: ApiLane, places: readonly string[]) =>
    places.every((key) => placesOf(lane, key) < shareOf(lane, key));
  /** Whether the request's own group, ignoring its Worker egress, may take one more place. */
  const groupHasShareLeft = (lane: ApiLane, places: readonly string[]) =>
    places.length > 0 && placesOf(lane, places[0]) < shareOf(lane, places[0]);

  function takePlaces(lane: PartnerAdmissionLane, places: readonly string[]) {
    if (!isApiLane(lane)) return;
    for (const key of places) placesByKey[lane].set(key, placesOf(lane, key) + 1);
  }

  function giveBackPlaces(lane: PartnerAdmissionLane, places: readonly string[]) {
    if (!isApiLane(lane)) return;
    for (const key of places) {
      const remaining = placesOf(lane, key) - 1;
      if (remaining <= 0) placesByKey[lane].delete(key);
      else placesByKey[lane].set(key, remaining);
    }
  }

  const runningApi = () => runningByLane.api + runningByLane['api-overflow'];
  const canRun = (lane: PartnerAdmissionLane) =>
    running < limits.permits &&
    runningByLane[lane] < laneCaps[lane] &&
    (!isApiLane(lane) || runningApi() < limits.apiPermits);

  function startRunning(lane: PartnerAdmissionLane, places: readonly string[]): PartnerLanePermit {
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
        giveBackPlaces(lane, places);
        admitNext();
      },
    };
  }

  function admitNext() {
    for (const lane of LANES_IN_PRIORITY_ORDER) {
      while (queues[lane].length > 0 && canRun(lane)) {
        const waiter = queues[lane].shift() as AdmissionWaiter;
        clearTimeout(waiter.deadline);
        waiter.grant(startRunning(lane, waiter.places));
      }
    }
  }

  /** Whether a request may take one more overflow place, and the queue has room for it. */
  const overflowHasRoomFor = (places: readonly string[]) =>
    queues['api-overflow'].length < queueLimits['api-overflow'] && hasShareLeft('api-overflow', places);

  function enqueue(waiter: AdmissionWaiter) {
    takePlaces(waiter.lane, waiter.places);
    queues[waiter.lane].push(waiter);
  }

  function dequeue(waiter: AdmissionWaiter) {
    queues[waiter.lane].splice(queues[waiter.lane].indexOf(waiter), 1);
    giveBackPlaces(waiter.lane, waiter.places);
  }

  /**
   * Frees one place in `lane` for a newcomer: of the waiters `weigh` names a
   * rival key for, the newest waiter of the rival holding the most places gives
   * its place up, but only if that rival holds more places than `newcomerKey`
   * would after taking one. A shared waiter that gives up moves to overflow when
   * it has room there, and is refused otherwise. Returns whether a place was freed.
   */
  function giveUpPlaceTo(
    lane: ApiLane,
    newcomerKey: string,
    weigh: (waiter: AdmissionWaiter) => string | undefined,
  ): boolean {
    let mostPlaces = placesOf(lane, newcomerKey) + 1;
    let newestOfLargest: AdmissionWaiter | undefined;
    // Newest first, so of the largest rival it is the newest waiter that goes.
    for (let index = queues[lane].length - 1; index >= 0; index -= 1) {
      const waiter = queues[lane][index];
      const key = weigh(waiter);
      if (key === undefined) continue;
      const held = placesOf(lane, key);
      if (held > mostPlaces) {
        mostPlaces = held;
        newestOfLargest = waiter;
      }
    }
    if (!newestOfLargest) return false;

    dequeue(newestOfLargest);
    if (lane === 'api' && overflowHasRoomFor(newestOfLargest.places)) {
      newestOfLargest.lane = 'api-overflow';
      enqueue(newestOfLargest);
    } else {
      clearTimeout(newestOfLargest.deadline);
      newestOfLargest.grant(null);
    }
    return true;
  }

  /**
   * A full queue: weighs every request by its group, or by its Worker egress
   * when it has one, so forged zones count as one.
   */
  function makeRoomFor(lane: ApiLane, places: readonly string[]): boolean {
    const newcomer = fairnessKey(places);
    return newcomer !== undefined && giveUpPlaceTo(lane, newcomer, (waiter) => fairnessKey(waiter.places));
  }

  /**
   * A full Worker share: the same rule among the zones of one egress, so two
   * junk zones holding every Worker place cannot shut a third zone out.
   */
  function makeRoomInEgress(lane: ApiLane, places: readonly string[]): boolean {
    const [zone, egress] = places;
    if (egress === undefined) return false;
    return giveUpPlaceTo(lane, zone, (waiter) => (waiter.places[1] === egress ? waiter.places[0] : undefined));
  }

  /** Whether a request has, or can be given, a place within its shares of `lane`. */
  const fitsShares = (lane: ApiLane, places: readonly string[]) =>
    hasShareLeft(lane, places) || (groupHasShareLeft(lane, places) && makeRoomInEgress(lane, places));

  return {
    acquire(requestedLane, addressGroup, egressGroup) {
      // Decided and counted here, synchronously, so concurrent requests from one
      // group cannot all see a free share and pass together.
      let lane = requestedLane;
      const places = isApiLane(requestedLane) ? placeKeys(addressGroup, egressGroup) : [];
      if (lane === 'api' && !fitsShares('api', places)) lane = 'api-overflow';
      // Refused without taking a place, so a refusal never counts against the group.
      if (lane === 'api-overflow' && !fitsShares(lane, places)) return Promise.resolve(null);

      if (canRun(lane) && queues[lane].length === 0) {
        takePlaces(lane, places);
        return Promise.resolve(startRunning(lane, places));
      }
      if (queues[lane].length >= queueLimits[lane]) {
        const roomMade = isApiLane(lane) && makeRoomFor(lane, places);
        if (!roomMade) return Promise.resolve(null);
      }
      return new Promise((resolve) => {
        const waiter: AdmissionWaiter = {
          lane,
          places,
          grant: resolve,
          deadline: setTimeout(() => {
            dequeue(waiter);
            resolve(null);
          }, limits.queueDeadlineMs),
        };
        waiter.deadline.unref();
        enqueue(waiter);
      });
    },
  };
}
