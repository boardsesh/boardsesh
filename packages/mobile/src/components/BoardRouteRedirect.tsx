// The whole body of every canonical board entry route (`app/[board_name]/…`,
// `app/b/[board_slug]/…`, and the legacy `climbs/[climbUuid]` redirector).
//
// Those routes are redirectors: they adopt the URL's board and hand off to the
// Climbs tab / play drawer, so the only thing they ever draw is a spinner or a
// not-found. Keeping that here means the seven route files stay at "read params,
// build a target" and can't drift from each other.

import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { Redirect, Stack, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { ActivityIndicator } from './ActivityIndicator';
import { Button } from './Button';
import { Icon } from './Icon';
import { Text } from './Text';
import { useTheme } from '../providers/theme-provider';
import { track } from '../lib/analytics';
import { buildLoginHrefWithReturn } from '../lib/routing/anonymous-auth-gate';
import type { BoardRouteTarget } from '../lib/routing/board-route-target';
import { useBoardRouteTarget, type BoardRouteMode, type BoardRouteStatus } from '../lib/routing/use-board-route-target';

/** Where `app/+not-found.tsx` sends people; the dead end below has to match it. */
const HOME_TAB = '/(tabs)/home' as const;

/** The terminal statuses worth a hand-off event, in the wire spelling. */
const HANDOFF_EVENT_STATUS = {
  resolved: 'resolved',
  'not-found': 'not_found',
  'auth-required': 'auth_required',
} as const satisfies Partial<Record<BoardRouteStatus, string>>;

/**
 * One `Board Route Handoff` per board-route open, at the moment it settles.
 *
 * Deliberately cross-platform. It is the only signal for whether deep links
 * resolve on the native fleet as well as on app.boardsesh.com, and it is
 * additive telemetry rather than a behaviour change. The ref keys on what is
 * reported, not on a bare flag, so a second URL through the same mounted screen
 * still reports — and a re-render at the same status does not double-fire.
 */
function useBoardRouteHandoffEvent(
  target: BoardRouteTarget | null,
  mode: BoardRouteMode | undefined,
  status: BoardRouteStatus,
) {
  const reportedRef = useRef<string | null>(null);
  const eventStatus = HANDOFF_EVENT_STATUS[status as keyof typeof HANDOFF_EVENT_STATUS];
  const kind = target?.kind ?? 'unparsed';
  const source = mode ?? 'deep-link';
  useEffect(() => {
    if (!eventStatus) return;
    const reportKey = `${kind}#${source}#${eventStatus}`;
    if (reportedRef.current === reportKey) return;
    reportedRef.current = reportKey;
    track(SHARED_EVENTS.BoardRouteHandoff, { kind, status: eventStatus, source });
  }, [eventStatus, kind, source]);
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
      {/* `resolved` draws the same spinner as `resolving`: the screen has handed
          off and is navigating away, and flashing the not-found on its way out
          would be a lie. */}
      {status === 'resolving' || status === 'resolved' ? (
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
  const status = useBoardRouteTarget(target, { mode });
  useBoardRouteHandoffEvent(target, mode, status);
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
