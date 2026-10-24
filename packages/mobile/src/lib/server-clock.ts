// The backend's clock as this phone sees it (#5382). The crew rest clock is
// stamped in server epoch ms, and every phone has to turn those instants into
// its own clock to count the same rest and fire on the same beat. This keeps an
// estimate of `offset = server clock − phone clock` and converts both ways.
// Module state, no React.
//
// Two kinds of sample feed it:
//
//   mutation  a `setSessionRestCadence` reply. The server read its clock once
//             somewhere between our send and our receive, so the offset sits in
//             [serverNow − received, serverNow − sent], and the midpoint of that
//             round trip is the estimate (off by at most half the round trip).
//   event     a subscription frame, stamped by the delivering instance as it
//             yields. It reached us `latency` later, so `serverNow − received`
//             is a lower bound on the offset. The highest one over the last five
//             minutes (a max filter) is the frame that travelled fastest, and is
//             the estimate when no round trip is known.
//
// The best round trip (the shortest) wins, clamped into the bounds every other
// sample proves. Samples older than five minutes drop out when a newer one
// lands; with none newer, the last estimate stands rather than resetting to
// zero, so a quiet clock keeps its calibration.

/** How long a sample counts. */
export const SERVER_CLOCK_WINDOW_MS = 5 * 60_000;

/** Enough samples for five minutes of a busy crew without unbounded growth. */
const MAX_SAMPLES = 64;

type BoundSample = { lowerBoundMs: number; receivedAtMs: number };

type RoundTripSample = BoundSample & { midpointMs: number; upperBoundMs: number; roundTripMs: number };

let eventSamples: BoundSample[] = [];
let roundTripSamples: RoundTripSample[] = [];
let estimateMs: number | null = null;

function prune<T extends { receivedAtMs: number }>(samples: T[], newestMs: number): T[] {
  const fresh = samples.filter((sample) => newestMs - sample.receivedAtMs <= SERVER_CLOCK_WINDOW_MS);
  return fresh.length > MAX_SAMPLES ? fresh.slice(fresh.length - MAX_SAMPLES) : fresh;
}

function recompute(): void {
  const lowerBounds = [...eventSamples, ...roundTripSamples].map((sample) => sample.lowerBoundMs);
  if (lowerBounds.length === 0) return;
  const lowerMs = Math.max(...lowerBounds);
  if (roundTripSamples.length === 0) {
    estimateMs = lowerMs;
    return;
  }
  // Shortest round trip first; the newest of equals, so a fresh sample wins a tie.
  const best = roundTripSamples.reduce((winner, sample) =>
    sample.roundTripMs <= winner.roundTripMs ? sample : winner,
  );
  const upperMs = Math.min(...roundTripSamples.map((sample) => sample.upperBoundMs));
  // Bounds that cross mean a clock stepped inside the window (NTP, or someone
  // changing the phone's time). Trust the best round trip alone until the old
  // samples age out.
  estimateMs = lowerMs <= upperMs ? Math.min(upperMs, Math.max(lowerMs, best.midpointMs)) : best.midpointMs;
}

/** A subscription frame's `serverNow`, received at `receivedAtMs` on this phone. */
export function noteServerTimeFromEvent({
  serverNowMs,
  receivedAtMs,
}: {
  serverNowMs: number;
  receivedAtMs: number;
}): void {
  if (!Number.isFinite(serverNowMs) || !Number.isFinite(receivedAtMs)) return;
  eventSamples = prune([...eventSamples, { lowerBoundMs: serverNowMs - receivedAtMs, receivedAtMs }], receivedAtMs);
  roundTripSamples = prune(roundTripSamples, receivedAtMs);
  recompute();
}

/** A mutation reply's `serverNow`, for a request sent at `sentAtMs` and answered at `receivedAtMs`. */
export function noteServerTimeFromMutation({
  serverNowMs,
  sentAtMs,
  receivedAtMs,
}: {
  serverNowMs: number;
  sentAtMs: number;
  receivedAtMs: number;
}): void {
  if (![serverNowMs, sentAtMs, receivedAtMs].every(Number.isFinite) || receivedAtMs < sentAtMs) return;
  const sample: RoundTripSample = {
    lowerBoundMs: serverNowMs - receivedAtMs,
    upperBoundMs: serverNowMs - sentAtMs,
    midpointMs: serverNowMs - (sentAtMs + receivedAtMs) / 2,
    roundTripMs: receivedAtMs - sentAtMs,
    receivedAtMs,
  };
  roundTripSamples = prune([...roundTripSamples, sample], receivedAtMs);
  eventSamples = prune(eventSamples, receivedAtMs);
  recompute();
}

/** `server clock − phone clock` in ms, or null before the first sample. */
export function getServerClockOffsetMs(): number | null {
  return estimateMs;
}

/** A server instant on this phone's clock. Before any sample, the two clocks are taken as equal. */
export function serverToLocalMs(serverMs: number): number {
  return serverMs - (estimateMs ?? 0);
}

/** A phone instant on the server's clock. */
export function localToServerMs(localMs: number): number {
  return localMs + (estimateMs ?? 0);
}

/** Forget every sample: a new session, or tests. */
export function resetServerClock(): void {
  eventSamples = [];
  roundTripSamples = [];
  estimateMs = null;
}
