// The whole body of every canonical board entry route (`app/[board_name]/…`,
// `app/b/[board_slug]/…`, and the legacy `climbs/[climbUuid]` redirector).
//
// Those routes are redirectors: they adopt the URL's board and hand off to the
// Climbs tab / play drawer, so the only thing they ever draw is a spinner or a
// not-found. Keeping that here means the seven route files stay at "read params,
// build a target" and can't drift from each other.

import { useCallback, useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { Redirect, Stack, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { onlineManager } from '@tanstack/react-query';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { ActivityIndicator } from './ActivityIndicator';
import { AnonymousClimbView } from './AnonymousClimbView';
import { Button } from './Button';
import { Icon } from './Icon';
import { Text } from './Text';
import { useAnonymousClimbViewEnabled } from '../providers/feature-flags-provider';
import { useTheme } from '../providers/theme-provider';
import { track } from '../lib/analytics';
import { buildLoginHrefWithReturn } from '../lib/routing/anonymous-auth-gate';
import { toBoardPath, type BoardRouteTarget } from '../lib/routing/board-route-target';
import { useBoardRouteTarget, type BoardRouteMode, type BoardRouteStatus } from '../lib/routing/use-board-route-target';

/** Where `app/+not-found.tsx` sends people; the dead end below has to match it. */
const HOME_TAB = '/(tabs)/home' as const;

/**
 * How a board-route open ended, in the wire spelling.
 *
 * `anonymous` is a signed-out reader who got the climb rather than the login
 * wall. A new VALUE rather than a new event on purpose: the funnel is
 * `Climb Handoff Clicked` ÷ `Board Route Handoff`, both stamped
 * `environment: production-web`, and a second event name would have split it.
 * Anonymous-vs-signed-in arrivals are a breakdown of the same ratio.
 */
type HandoffEventStatus = 'resolved' | 'not_found' | 'auth_required' | 'anonymous';

/**
 * The terminal statuses the screen SITS on, in the wire spelling.
 *
 * A successful hand-off is not among them — it has no status at all, because the
 * effect that performs it also navigates this screen out of the tree. See
 * `useBoardRouteHandoffReporter`.
 */
const RENDERED_EVENT_STATUS = {
  'not-found': 'not_found',
  'auth-required': 'auth_required',
  'anonymous-climb': 'anonymous',
} as const satisfies Partial<Record<BoardRouteStatus, HandoffEventStatus>>;

/** The URL a report is about, so two different climbs each get their own event. */
function targetIdentity(target: BoardRouteTarget | null): string {
  if (!target) return 'unparsed';
  const climbUuid = target.kind === 'climb' || target.kind === 'slug-climb' ? target.climbUuid : '';
  return `${toBoardPath(target)}#${climbUuid}`;
}

/**
 * One `Board Route Handoff` per board-route open, at the moment it settles.
 *
 * Deliberately cross-platform. It is the only signal for whether deep links
 * resolve on the native fleet as well as on app.boardsesh.com, and it is
 * additive telemetry rather than a behaviour change. The ref keys on the URL and
 * the outcome — not a bare flag, and not the coarse event props — so a second
 * URL through the same mounted screen reports even when it settles the same way,
 * while a re-render at the same outcome does not double-fire. The URL never
 * leaves this file: the event itself carries only `{ kind, status, source }`.
 *
 * Returns the reporter rather than firing on a status, because the outcomes
 * arrive by two different routes. `not-found` and `auth-required` are statuses
 * the screen sits on, so watching the status is enough. A successful hand-off
 * never becomes a status: the effect that performs it calls `router.replace` /
 * `router.back` in the same body, React batches that with anything else queued
 * in the flush, and the navigator drops this screen in the very render that
 * would have carried it — so `resolved` is fired imperatively from inside the
 * hand-off, the way `join/[sessionId]` fires `Session Joined` before it replaces
 * itself. Whichever route reports first, the key dedupes the other.
 */
function useBoardRouteHandoffReporter(target: BoardRouteTarget | null, mode: BoardRouteMode | undefined) {
  const reportedRef = useRef<string | null>(null);
  const kind = target?.kind ?? 'unparsed';
  const source = mode ?? 'deep-link';
  const identity = targetIdentity(target);
  return useCallback(
    (eventStatus: HandoffEventStatus) => {
      const reportKey = `${identity}#${source}#${eventStatus}`;
      if (reportedRef.current === reportKey) return;
      reportedRef.current = reportKey;
      track(SHARED_EVENTS.BoardRouteHandoff, { kind, status: eventStatus, source });
    },
    [identity, kind, source],
  );
}

export function BoardRouteRedirect({ status }: { status: BoardRouteStatus }) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();
  const router = useRouter();

  // Web-only in practice: a signed-out visitor on a read-only board route. Send
  // them to login carrying the path so the climb survives the round trip. On
  // native `buildLoginHrefWithReturn()` is a constant `/auth/login` and this
  // status is unreachable — `RELAXES_ANONYMOUS_ROUTES` is false there.
  if (status === 'auth-required') return <Redirect href={buildLoginHrefWithReturn()} />;

  return (
    <View style={styles.container}>
      {/* Headerless: a redirector that shows a back chevron for the split second
          before it navigates away just looks like a broken screen. */}
      <Stack.Screen options={{ headerShown: false }} />
      {/* A handed-off screen keeps this spinner on its way out — nothing flips it
          to the not-found, because the board and climb it handed off with are
          both still there.

          `anonymous-climb` reaching HERE means the caller had the status but not
          the climb — a state `resolveStatus` refuses to produce today (it only
          says `anonymous-climb` once the climb has landed). It waits on the
          spinner rather than falling through, because the alternative reading of
          "the climb has not arrived yet" is "Not found" plus a Back-to-home
          button, on a URL that is about to resolve. */}
      {status === 'resolving' || status === 'anonymous-climb' ? (
        <ActivityIndicator size="large" />
      ) : (
        <>
          <Icon name="error" size={48} color={systemColors.secondaryLabel} />
          <Text variant="headline" style={styles.errorText}>
            {t('mobile.detail.notFound')}
          </Text>
          {/* The one way out. These routes mount headerless at the ROOT stack, so
              a cold open from a dead link has no header, no tab bar and nothing
              beneath it — on Android the only remaining gesture is back, which
              exits the app. `replace`, not `push`: the broken URL must not stay
              on the stack for back to return to. */}
          <Button title={t('mobile.detail.backToHome')} onPress={() => router.replace(HOME_TAB)} variant="tonal" />
        </>
      )}
    </View>
  );
}

/**
 * Drive `target` to its destination and render the redirector while it happens.
 * `target` is `null` when the URL didn't parse, which renders the not-found.
 */
export function BoardRouteHandoff({ target, mode }: { target: BoardRouteTarget | null; mode?: BoardRouteMode }) {
  const report = useBoardRouteHandoffReporter(target, mode);
  const onHandedOff = useCallback(() => report('resolved'), [report]);
  // Read unconditionally, applied only where the gate already relaxes: on native
  // `RELAXES_ANONYMOUS_ROUTES` is false, so the flag cannot reach a decision
  // there however it resolves.
  const anonymousClimbEnabled = useAnonymousClimbViewEnabled();
  const { status, climb, boardConfig, isAngleAdjustable } = useBoardRouteTarget(target, {
    mode,
    onHandedOff,
    anonymousClimbEnabled,
  });

  const renderedStatus = RENDERED_EVENT_STATUS[status as keyof typeof RENDERED_EVENT_STATUS];
  const parsedUrl = target !== null;
  useEffect(() => {
    if (!renderedStatus) return;
    // A parsed URL that fails with no network is not a dead link. The hook
    // watches `onlineManager` and re-resolves when the signal comes back, and
    // that second pass hands off — so reporting here would file a `not_found`
    // for every offline cold open that later succeeds, and count the same open
    // twice once the `resolved` follows it. A URL that didn't parse is a dead
    // end whatever the network is doing.
    if (renderedStatus === 'not_found' && parsedUrl && !onlineManager.isOnline()) return;
    report(renderedStatus);
  }, [parsedUrl, renderedStatus, report]);

  // The one status this component does not redirect for: the climb is drawn
  // right here, on the URL the visitor arrived at, because every route the
  // hand-off would navigate to is behind the login gate.
  if (status === 'anonymous-climb' && climb && boardConfig) {
    return <AnonymousClimbView climb={climb} boardConfig={boardConfig} isAngleAdjustable={isAngleAdjustable} />;
  }

  return <BoardRouteRedirect status={status} />;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  errorText: {
    opacity: 0.6,
  },
});
