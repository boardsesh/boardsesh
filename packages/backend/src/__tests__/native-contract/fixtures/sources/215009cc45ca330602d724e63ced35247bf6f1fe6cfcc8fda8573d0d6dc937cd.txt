import { getPostHogClient } from './posthog-client';

// Suppresses repeat `$screen` events for a screen already seen in the current
// PostHog session.
//
// `$screen` is the project's single biggest event — 327k/month, 29% of all
// ingestion — but only ~96k of those are distinct (person, session, screen)
// triples. The rest is the /climbs ↔ /play ping-pong: ~34 events per person per
// month on each of those two routes alone. One event per screen per session
// keeps every metric that counts PEOPLE (DAU/WAU/MAU, stickiness, lifecycle,
// retention, first_time_for_user) bit-identical, because a person active in an
// interval still has at least one session and therefore at least one $screen.
//
// What it gives up — per-navigation counts and ordered A→B→A paths — is already
// recorded in full elsewhere: expo-observe writes a row per navigation per
// device into `observe_metrics` on the xprem ClickHouse, at 100% sampling
// (OBSERVE_DEFAULT_SAMPLE_RATE = 1 in observe-config.ts). See docs/railway.md.
//
// Sessions are the epoch on purpose: PostHog rotates a session id after 30
// minutes idle (`sessionExpirationTimeSeconds`, SDK default, which
// buildPostHogOptions does not override) with a hard 24h ceiling, so the gate
// re-arms on its own and needs no day-boundary logic of its own.

export type ScreenSessionGate = {
  shouldEmit: (screenName: string) => boolean;
  reset: () => void;
};

/**
 * Pure factory — `readSessionId` is injected so the gate is testable with no
 * PostHog client, mirroring `createOfflineUsageSignal`'s seam.
 *
 * State is deliberately in-memory only. A relaunch inside the 30-minute window
 * re-arms the gate against a session id that has not rotated, so a killed app
 * can re-emit a screen it already reported. That errs toward emitting, which is
 * the safe direction for a metric whose failure mode is under-counting people.
 */
export function createScreenSessionGate(readSessionId: () => string | null | undefined): ScreenSessionGate {
  const seen = new Set<string>();
  let currentSessionId: string | null = null;

  return {
    shouldEmit(screenName: string): boolean {
      let sessionId: string | null | undefined;
      try {
        sessionId = readSessionId();
      } catch {
        // A client that cannot report a session must never cost us an event.
        return true;
      }
      // `getSessionId()` returns '' (never null) until the SDK finishes hydrating
      // its persisted storage, so the first navigation of a cold launch can land
      // here. Emit and record nothing: at worst one duplicate per launch, and the
      // screen is still gated once a real id arrives.
      if (!sessionId) return true;

      if (sessionId !== currentSessionId) {
        currentSessionId = sessionId;
        seen.clear();
      }
      if (seen.has(screenName)) return false;
      seen.add(screenName);
      return true;
    },
    reset(): void {
      seen.clear();
      currentSessionId = null;
    },
  };
}

const screenSessionGate = createScreenSessionGate(() => getPostHogClient()?.getSessionId() ?? null);

/** True when this screen has not yet been reported in the current session. */
export function shouldEmitScreenForSession(screenName: string): boolean {
  return screenSessionGate.shouldEmit(screenName);
}

/**
 * Clear the gate on sign-out / account switch. `client.reset()` already rotates
 * the session id, so this is belt-and-braces — but it keeps the behaviour
 * explicit and testable rather than dependent on an SDK side effect.
 */
export function resetScreenSessionGate(): void {
  screenSessionGate.reset();
}
