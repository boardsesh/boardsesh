// Offline-usage rollup gate (issue #4317).
//
// The problem: every offline-served read funnels through ONE interceptor, and
// that interceptor sees five registered documents — search, search count, climb
// detail, and two grade reads. Search and its count fire on every keystroke, so
// a per-read event would be thousands of events per user per session. PostHog's
// offline queue holds 1000 events and drops the OLDEST when full, so a chatty
// read event captured offline would evict the very events (ticks, screens) it
// shares the queue with. Per-read is not an option; the signal has to be a
// rollup.
//
// The gate: an in-memory counter keyed by (UTC epoch-day, lane, board) that
// emits only when the count crosses a rung of a ladder — first read of the day,
// then 10, then 100. Per SUPPRESSED read the whole cost is one integer compare,
// one Map lookup and one increment: no I/O, no persistence, no Date formatting,
// no battery. A pathological user tops out around 3 lanes x 2 boards x 3 rungs
// = 18 events/day; the typical user emits one or two.
//
// Rung 1 fires on the very first qualifying read, so the north-star (weekly
// users with >=1 offline-served read) can never be lost to an app kill — the
// deeper rungs only add depth, they never gate the headline metric.
//
// The counter is deliberately NOT persisted. A process restart re-arms the day,
// which can double-count a user across relaunches; that is harmless for a
// unique-users metric and buys us zero storage dependencies. It also means the
// consumer MUST call reset() on sign-out, or a same-day account switch inherits
// the previous user's suppression map and the new user's first offline day
// silently never fires.
//
// Pure TS with `emit` and `now` injected, like every other seam in this package
// — it never imports an analytics client, so a future web offline consumer can
// bind the same gate to its own telemetry.

// Which local-read lane the interceptor took.
//   offline_local       — device reported offline, served from the downloaded board. The value prop.
//   network_error_local — the request reached the network and threw, and the downloaded board
//                         rescued it. Real offline value that `onlineManager` mislabels as online
//                         (captive portal, dead gym-wifi upstream, cold-start seed race).
//   online_local        — device reported online and the engine flag short-circuited to local.
//                         A latency optimization, NOT offline usage — excluded from the north-star.
export type OfflineReadLane = 'offline_local' | 'network_error_local' | 'online_local';

// The read that crossed the rung. Descriptive only — it is NOT part of the
// dedupe key, so this is "the surface that happened to trip the counter", not an
// exhaustive list of surfaces the user browsed.
export type OfflineReadSurface = 'search' | 'climb_detail' | 'grade';

// Why an offline read came back empty.
//   board_not_downloaded — nothing local for this board scope. The audience #4318 exists to convert.
//   filter_unsupported   — the board IS downloaded but the filter needs a table we don't sync
//                          (hold state, zone, tall/wide, beta, drafts) — the #4002 gap.
//   local_db_unavailable — there was no database handle to ask at all (init still retrying, or
//                          wedged — #4313 / #4314). Kept separate on purpose: the board may well
//                          BE downloaded, so folding this into board_not_downloaded would aim
//                          #4318's "download a board" nudge at people who already have one.
export type OfflineUnavailableReason = 'board_not_downloaded' | 'filter_unsupported' | 'local_db_unavailable';

export type OfflineUsageEmission =
  | { kind: 'served'; lane: OfflineReadLane; surface: OfflineReadSurface; boardName: string; readCount: number }
  | {
      kind: 'unavailable';
      reason: OfflineUnavailableReason;
      surface: OfflineReadSurface;
      boardName: string;
      readCount: number;
    };

export type OfflineUsageSignalOptions = {
  // Bound by the app to its analytics client. Must not throw — the gate calls it
  // from a read path — but the gate swallows anything it does anyway.
  emit: (emission: OfflineUsageEmission) => void;
  now?: () => number;
  // Counts at which an emission fires. Ascending, first entry should be 1 so the
  // north-star is guaranteed on the first read.
  ladder?: readonly number[];
  // Hard backstop against any future call site turning this into a firehose:
  // once this many emissions have fired on the current UTC day, the gate goes
  // quiet until the day rolls over (or reset() runs). Per-DAY rather than
  // per-process on purpose — a phone can keep this process resident for weeks,
  // and a lifetime cap would eventually mute the north-star for exactly the
  // heaviest offline users, which is the silent under-count this signal exists
  // to eliminate.
  maxEmitsPerDay?: number;
};

export type OfflineUsageSignal = {
  recordRead: (read: { lane: OfflineReadLane; surface: OfflineReadSurface; boardName: string }) => void;
  recordUnavailable: (miss: {
    reason: OfflineUnavailableReason;
    surface: OfflineReadSurface;
    boardName: string;
  }) => void;
  reset: () => void;
};

const MILLISECONDS_PER_DAY = 86_400_000;
const DEFAULT_LADDER: readonly number[] = [1, 10, 100];
const DEFAULT_MAX_EMITS_PER_DAY = 60;

// UTC epoch-day as a plain integer — no Intl, no Date object, no allocation, so
// it is cheap enough to run on every suppressed read.
function epochDay(timestamp: number): number {
  return Math.floor(timestamp / MILLISECONDS_PER_DAY);
}

export function createOfflineUsageSignal({
  emit,
  now = Date.now,
  ladder = DEFAULT_LADDER,
  maxEmitsPerDay = DEFAULT_MAX_EMITS_PER_DAY,
}: OfflineUsageSignalOptions): OfflineUsageSignal {
  const countsByKey = new Map<string, number>();
  let currentEpochDay = epochDay(now());
  let emitsToday = 0;

  // Returns the new count when it crossed a ladder rung, otherwise null.
  function countAndCheckRung(key: string): number | null {
    const day = epochDay(now());
    if (day !== currentEpochDay) {
      currentEpochDay = day;
      countsByKey.clear();
      emitsToday = 0;
    }
    const count = (countsByKey.get(key) ?? 0) + 1;
    countsByKey.set(key, count);
    if (!ladder.includes(count)) return null;
    if (emitsToday >= maxEmitsPerDay) return null;
    emitsToday += 1;
    return count;
  }

  // The gate owns the try/catch so no call site on a read path has to.
  function safeEmit(emission: OfflineUsageEmission): void {
    try {
      emit(emission);
    } catch {
      // Telemetry must never break a read.
    }
  }

  return {
    recordRead({ lane, surface, boardName }) {
      const readCount = countAndCheckRung(`served|${lane}|${boardName}`);
      if (readCount === null) return;
      safeEmit({ kind: 'served', lane, surface, boardName, readCount });
    },
    recordUnavailable({ reason, surface, boardName }) {
      const readCount = countAndCheckRung(`unavailable|${reason}|${boardName}`);
      if (readCount === null) return;
      safeEmit({ kind: 'unavailable', reason, surface, boardName, readCount });
    },
    reset() {
      countsByKey.clear();
      currentEpochDay = epochDay(now());
      emitsToday = 0;
    },
  };
}
