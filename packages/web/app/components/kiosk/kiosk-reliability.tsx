'use client';

// Reliability plumbing for a 24/7 unattended TV. Nothing here renders UI.
//
// Three layers, from cheapest to bluntest:
//  1. Per-board catch-up (KioskBoardFeedBridge): the live feed rides Redis
//     pub/sub with no replay, so a throttled/suspended socket silently drops
//     events. A 5-minute `refresh('manual')` + a visibilitychange catch-up
//     re-reads the durable history. The ws client's own reconnect/backoff (and
//     the shared hook's reconnect catch-up) handle the fast path — this is the
//     slow safety net.
//  2. Config poll (KioskReliability): re-fetch the kiosk config every 5
//     minutes over anon HTTP; when `updatedAt` moves (or the kiosk vanishes),
//     `location.reload()` picks up the new layout server-side.
//  3. Daily 04:00 reload: clears whatever a week-long browser session accrues
//     (detached listeners, fragmented heap, stale JS after a deploy).
//
// Plus a screen wake lock so the TV never sleeps mid-session.

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  useBoardPresenceActions,
  useBoardPresenceCurrent,
  useBoardPresenceFeed,
} from '@boardsesh/board-presence-react';
import {
  GET_GYM_KIOSK,
  KIOSK_HEARTBEAT,
  type GetGymKioskQueryResponse,
  type KioskHeartbeatMutationResponse,
  type KioskHeartbeatMutationVariables,
} from '@boardsesh/graphql/operations';
import { KIOSK_HEARTBEAT_INTERVAL_MS } from '@boardsesh/kiosk';
import { executeGraphQL } from '@/app/lib/graphql/client';
import { useWakeLock } from '@/app/lib/hooks/use-wake-lock';
import { evaluateKioskConfigPoll } from './kiosk-config-poll';
import type { KioskBoardSnapshot } from './presence/use-kiosk-board-presence';

/** How often each board re-reads the durable history to repair silent drops. */
const BOARD_FEED_CATCH_UP_INTERVAL_MS = 5 * 60 * 1000;
/**
 * How often the kiosk config is re-fetched to detect a re-configured layout.
 * The heartbeat rides this poll (fires on each completed fetch), so it's the
 * kiosk's single check-in cadence — sourced from the shared constant the
 * manage-UI liveness window also derives from, so the two never drift.
 */
const CONFIG_POLL_INTERVAL_MS = KIOSK_HEARTBEAT_INTERVAL_MS;
/**
 * Minimum page age before a config mismatch may reload. The server render is
 * cached with `revalidate: 60`, so right after an edit a reload can serve the
 * SAME stale HTML while the client poll already sees the new `updatedAt` —
 * reloading immediately would loop until the cache revalidates. Waiting out
 * the revalidate window (with margin) bounds it to one reload per poll tick.
 */
const MIN_PAGE_AGE_BEFORE_RELOAD_MS = 90 * 1000;
/** Local hour for the daily maintenance reload (4am — gyms are empty). */
const DAILY_RELOAD_HOUR = 4;

/**
 * Mounted by the presence hub INSIDE each board's BoardPresenceProvider.
 * Publishes the board's live snapshot up to the hub's Map context and runs the
 * per-board catch-up cadence (layer 1 above).
 */
export function KioskBoardFeedBridge({
  boardId,
  onSnapshot,
}: {
  boardId: number;
  onSnapshot: (boardId: number, snapshot: KioskBoardSnapshot) => void;
}) {
  const { currentClimb, isLive } = useBoardPresenceCurrent();
  const { history } = useBoardPresenceFeed();
  const { refresh } = useBoardPresenceActions();

  useEffect(() => {
    onSnapshot(boardId, { currentClimb, history, isLive });
  }, [boardId, onSnapshot, currentClimb, history, isLive]);

  useEffect(() => {
    const intervalId = setInterval(() => refresh('manual'), BOARD_FEED_CATCH_UP_INTERVAL_MS);
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refresh('foreground');
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      clearInterval(intervalId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [refresh]);

  return null;
}

/**
 * Page-level reliability: wake lock, config-change reload, daily reload
 * (layers 2 + 3 above). Mounted once per kiosk page.
 */
export default function KioskReliability({
  gymSlug,
  kioskSlug,
  kioskUuid,
  gymUuid,
  initialUpdatedAt,
}: {
  gymSlug: string;
  kioskSlug: string | null;
  /** The kiosk's UUID — the heartbeat key (only the display pages send one; the
   * manage preview builds its own tree without this component, so heartbeats are
   * display-only by construction). */
  kioskUuid: string;
  /** The owning gym's UUID — scopes the heartbeat keyspace. */
  gymUuid: string;
  /** The kiosk's `updatedAt` at server-render time; any change forces a reload. */
  initialUpdatedAt: string;
}) {
  useWakeLock(true);

  const { data: kioskConfigData, dataUpdatedAt } = useQuery({
    queryKey: ['kioskConfigPoll', gymSlug, kioskSlug],
    queryFn: () =>
      executeGraphQL<GetGymKioskQueryResponse>(GET_GYM_KIOSK, { gymSlug, kioskSlug: kioskSlug ?? undefined }),
    refetchInterval: CONFIG_POLL_INTERVAL_MS,
    // A TV never backgrounds, but if the browser reports hidden anyway, keep
    // polling — the whole point is unattended freshness.
    refetchIntervalInBackground: true,
    staleTime: CONFIG_POLL_INTERVAL_MS,
  });

  // Client mount time. useState initializer (not a ref-in-effect) so it's set
  // during the very first render — the decision effect below may run earlier
  // than any layout effect ordering games would guarantee for a ref.
  const [mountedAtMs] = useState(() => Date.now());

  // Evaluate on every completed poll. Keyed on `dataUpdatedAt`, NOT just
  // `data`: React Query's structural sharing keeps `data` referentially
  // identical across refetches with equal payloads, so a mismatch that was
  // gated by the age floor would otherwise never re-fire this effect and the
  // TV would sit stale until the daily reload. A gated mismatch additionally
  // schedules a one-shot recheck for the moment the floor expires (see
  // evaluateKioskConfigPoll — the pure decision logic).
  //
  // Kiosk deleted/hidden → reload into the 404 (honest signal for the gym).
  // updatedAt moved → the owner re-configured it; reload to re-render
  // server-side with the new layout/branding.
  useEffect(() => {
    if (kioskConfigData === undefined) return;
    const polledUpdatedAt = kioskConfigData.gymKiosk === null ? null : kioskConfigData.gymKiosk.updatedAt;

    let recheckTimeoutId: ReturnType<typeof setTimeout> | undefined;
    const decide = () => {
      const decision = evaluateKioskConfigPoll({
        pageAgeMs: Date.now() - mountedAtMs,
        initialUpdatedAt,
        polledUpdatedAt,
        minPageAgeMs: MIN_PAGE_AGE_BEFORE_RELOAD_MS,
      });
      if (decision.action === 'reload') {
        window.location.reload();
      } else if (decision.action === 'recheck') {
        recheckTimeoutId = setTimeout(decide, decision.delayMs);
      }
    };
    decide();
    return () => clearTimeout(recheckTimeoutId);
  }, [kioskConfigData, dataUpdatedAt, initialUpdatedAt, mountedAtMs]);

  // Heartbeat: check in so owners can see this TV is live, straight from the
  // Kiosks tab. Piggybacks the config poll's cadence rather than adding a second
  // timer — `dataUpdatedAt` advances on the first successful fetch (initial
  // load) and on every 5-minute refetch, which is exactly when we want to
  // report. Tying it to a completed poll also means "live" reflects the TV
  // actually reaching the backend, not just a mounted component. A failed send
  // is inconsequential: the next poll re-reports, and the backend TTL is
  // generous, so a brief gap never reads as "dead".
  useEffect(() => {
    if (dataUpdatedAt === 0) return;
    // Viewport is a best-effort coarse marker: only send it when the browser
    // reports real dimensions. A headless/hidden context can report 0 — the
    // backend's `min(1)` would reject the whole heartbeat, so omit the fields
    // rather than lose the check-in.
    const viewport =
      window.innerWidth > 0 && window.innerHeight > 0
        ? { viewportWidth: window.innerWidth, viewportHeight: window.innerHeight }
        : {};
    void executeGraphQL<KioskHeartbeatMutationResponse, KioskHeartbeatMutationVariables>(KIOSK_HEARTBEAT, {
      input: { kioskUuid, gymUuid, ...viewport },
    }).catch(() => {
      // Swallow — the next poll tick re-reports.
    });
  }, [dataUpdatedAt, kioskUuid, gymUuid]);

  useEffect(() => {
    const now = new Date();
    const nextReload = new Date(now);
    nextReload.setHours(DAILY_RELOAD_HOUR, 0, 0, 0);
    if (nextReload <= now) {
      nextReload.setDate(nextReload.getDate() + 1);
    }
    const timeoutId = setTimeout(() => window.location.reload(), nextReload.getTime() - now.getTime());
    return () => clearTimeout(timeoutId);
  }, []);

  return null;
}
