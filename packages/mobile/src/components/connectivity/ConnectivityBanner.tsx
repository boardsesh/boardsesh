// One honest banner for "the app cannot reach the server right now" (issue
// #4862), mounted ONCE at the app root so it can say the same thing on every
// screen instead of each surface inventing its own empty state.
//
// Three things drove the shape:
//
//  - It sits at the BOTTOM. An outage is not a header — it is a condition the
//    climber lives with while they keep browsing, and a top banner shoves every
//    screen's content down each time the probe flips.
//  - Recovery happens IN the banner. "Back online. Syncing 3 changes…" → "All
//    synced" closes the loop the outage opened; a banner that just vanishes
//    leaves the climber wondering whether their sends went anywhere.
//  - It counts CHANGES, not sends. Favourites and follows queue up too, and a
//    number that only counted ticks would read as lost data.
//
// It never hides itself while the app is offline. The pill is the collapsed
// form, and in offline mode it is also the only way back online.

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Text } from '../Text';
import { Icon } from '../Icon';
import type { IconName } from '../icon-map';
import { Button } from '../Button';
import { ActivityIndicator } from '../ActivityIndicator';
import { useTheme } from '../../providers/theme-provider';
import { useAuth } from '../../providers/auth-provider';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { useReduceMotion } from '../../hooks/use-reduce-motion';
import { publishConnectivityBannerHeight } from '../../lib/connectivity-banner-inset-store';
import { withAlpha } from '../../theme/colors';
import { borderRadius, spacing } from '../../theme/tokens';
import { useConnectivityBanner } from './use-connectivity-banner';
import type { BannerState } from './connectivity-banner-state';

// Wide enough for three lines of copy on a phone, narrow enough that it reads as
// a card rather than a full-width bar on an iPad.
const MAX_BANNER_WIDTH = 520;

// A state change the climber cannot see (the card is off screen, or another
// announcement is mid-sentence) is worth waiting out. Same budget as the
// wall-state announcer.
const ANNOUNCE_DEBOUNCE_MS = 300;

/** Which brand hue washes the surface; `none` leaves it plain. */
type BannerTint = 'warning' | 'primary' | 'success' | 'none';

type BannerAction = {
  key: string;
  label: string;
  onPress: () => void;
  variant: 'tonal' | 'text';
  loading: boolean;
};

type BannerPresentation = {
  icon: IconName;
  tint: BannerTint;
  title: string;
  body: string | null;
  /** Collapsed-form label. */
  pillLabel: string;
  /** A spinner replaces the glyph while work is actually happening. */
  busy: boolean;
};

/**
 * The app-wide connectivity banner. `ready` gates it behind the same
 * auth-plus-fonts signal the onboarding gate uses, so it never paints over the
 * splash.
 */
export function ConnectivityBanner({ ready }: { ready: boolean }) {
  // Screenshot builds never show it: a store screenshot must not carry a "server
  // trouble" card, and the capture rig has no backend to reach anyway.
  if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1') return null;
  if (!ready) return null;
  return <ConnectivityBannerContent />;
}

function ConnectivityBannerContent() {
  const { t } = useTranslation('common');
  const { state, dismiss, expand, retry, stayOffline, goOnline, openSyncIssues } = useConnectivityBanner();
  const { systemColors, brandColors, colorScheme } = useTheme();
  const { isAuthenticated } = useAuth();
  const bottomChrome = useBottomChromeMetrics();
  const reduceMotion = useReduceMotion();

  const visible = state.kind !== 'hidden';
  const collapsed = state.kind === 'active' && !state.expanded;

  const presentation = useMemo(() => resolvePresentation(state, t), [state, t]);
  const pendingCount = useMemo(() => resolvePendingCount(state), [state]);
  // Signed-out climbers have no outbox: nothing of theirs is waiting, and
  // offline mode is an account-level setting they cannot reach.
  const showsAccountUi = isAuthenticated;
  const countLine =
    showsAccountUi && pendingCount > 0 && state.kind === 'active'
      ? t('mobile.connectivity.pending', { count: pendingCount })
      : null;

  const actions = useMemo(
    () => resolveActions({ state, t, showsAccountUi, retry, stayOffline, goOnline, openSyncIssues }),
    [state, t, showsAccountUi, retry, stayOffline, goOnline, openSyncIssues],
  );

  const publishHeight = useCallback((event: LayoutChangeEvent) => {
    // TWO gaps, not one: the banner sits `spacing[2]` above the chrome beneath
    // it, and whatever floats above it needs its own `spacing[2]` of air. One gap
    // would clear the card exactly, landing a FAB flush against its top edge.
    publishConnectivityBannerHeight(event.nativeEvent.layout.height + spacing[2] * 2);
  }, []);

  useEffect(() => {
    if (visible) return;
    // Nothing on screen reserves nothing. Without this, every list would keep a
    // banner-sized hole at the bottom for the rest of the session.
    publishConnectivityBannerHeight(0);
  }, [visible]);

  useEffect(() => () => publishConnectivityBannerHeight(0), []);

  // Announce the PHASE, not every re-render: a count ticking down during a drain
  // is not worth interrupting a screen reader for, but "Back online" and "All
  // synced" are the whole point of the recovery card.
  const announceKey = `${state.kind}:${state.kind === 'active' ? state.reason : ''}`;
  const titleRef = useRef(presentation.title);
  titleRef.current = presentation.title;
  useEffect(() => {
    if (!visible) return;
    const handle = setTimeout(() => AccessibilityInfo.announceForAccessibility(titleRef.current), ANNOUNCE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [announceKey, visible]);

  if (!visible) return null;

  const accentColor = presentation.tint === 'none' ? systemColors.secondaryLabel : brandColors[presentation.tint];
  // An opaque surface plus a brand-hued wash, exactly like Toast: the banner
  // floats over arbitrary content (board art, photos), where a translucent card
  // is unreadable. Dark mode needs the heavier wash to register at all.
  const washAlpha = colorScheme === 'dark' ? 0.24 : 0.15;
  const tintColor = presentation.tint === 'none' ? null : withAlpha(brandColors[presentation.tint], washAlpha);
  const surfaceColors = { backgroundColor: systemColors.secondaryBackground, borderColor: systemColors.separator };
  const entering = reduceMotion ? undefined : FadeIn.duration(180);
  const exiting = reduceMotion ? undefined : FadeOut.duration(150);

  return (
    <View
      pointerEvents="box-none"
      style={[styles.overlay, { bottom: bottomChrome.connectivityBannerBottom + spacing[2] }]}
    >
      {collapsed ? (
        <Animated.View
          key="pill"
          entering={entering}
          exiting={exiting}
          onLayout={publishHeight}
          style={[styles.pill, surfaceColors]}
        >
          {tintColor ? (
            <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: tintColor }]} />
          ) : null}
          <Pressable
            onPress={expand}
            accessibilityRole="button"
            accessibilityLabel={countLine ? `${presentation.title}. ${countLine}` : presentation.title}
            accessibilityHint={t('mobile.connectivity.expand')}
            style={styles.pillPressable}
          >
            <Icon name={presentation.icon} size={16} color={accentColor} />
            <Text variant="subheadline" color={systemColors.label}>
              {presentation.pillLabel}
            </Text>
            {countLine && pendingCount > 0 ? (
              <View style={[styles.badge, { backgroundColor: systemColors.fill }]}>
                <Text variant="caption1" color={systemColors.label}>
                  {String(pendingCount)}
                </Text>
              </View>
            ) : null}
          </Pressable>
        </Animated.View>
      ) : (
        <Animated.View
          key="card"
          entering={entering}
          exiting={exiting}
          onLayout={publishHeight}
          style={[styles.card, surfaceColors]}
        >
          {tintColor ? (
            <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: tintColor }]} />
          ) : null}
          <View style={styles.headerRow}>
            {/* Title + body + count are ONE announcement; the buttons stay
                separately focusable so a screen-reader user can act on them. */}
            <View accessible accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.message}>
              <View style={styles.titleRow}>
                {presentation.busy ? (
                  <ActivityIndicator size="small" />
                ) : (
                  <Icon name={presentation.icon} size={20} color={accentColor} />
                )}
                <Text variant="headline" color={systemColors.label} style={styles.title}>
                  {presentation.title}
                </Text>
              </View>
              {presentation.body ? (
                <Text variant="subheadline" color={systemColors.secondaryLabel}>
                  {presentation.body}
                </Text>
              ) : null}
              {countLine ? (
                <Text variant="footnote" color={systemColors.secondaryLabel}>
                  {countLine}
                </Text>
              ) : null}
            </View>
            <Pressable
              onPress={dismiss}
              accessibilityRole="button"
              accessibilityLabel={t('mobile.connectivity.dismiss')}
              hitSlop={8}
              style={styles.close}
            >
              <Icon name="close" size={16} color={systemColors.secondaryLabel} />
            </Pressable>
          </View>
          {actions.length > 0 ? (
            <View style={styles.actions}>
              {actions.map((action) => (
                <Button
                  key={action.key}
                  title={action.label}
                  variant={action.variant}
                  size="small"
                  loading={action.loading}
                  onPress={action.onPress}
                />
              ))}
            </View>
          ) : null}
        </Animated.View>
      )}
    </View>
  );
}

function resolvePendingCount(state: BannerState): number {
  switch (state.kind) {
    case 'active':
    case 'recovering':
      return state.pendingCount;
    default:
      return 0;
  }
}

function resolvePresentation(state: BannerState, t: TFunction<'common'>): BannerPresentation {
  switch (state.kind) {
    case 'recovering':
      return {
        icon: 'refresh',
        tint: 'primary',
        title: t('mobile.connectivity.recovering.backOnline'),
        body: t('mobile.connectivity.recovering.syncing', { count: state.pendingCount }),
        pillLabel: t('mobile.connectivity.recovering.backOnline'),
        busy: true,
      };
    case 'synced':
      return {
        icon: 'success',
        tint: 'success',
        title: t('mobile.connectivity.recovering.synced'),
        body: null,
        pillLabel: t('mobile.connectivity.recovering.synced'),
        busy: false,
      };
    case 'needs_retry': {
      const title = t('mobile.connectivity.recovering.needsRetry', { count: state.deadLettered });
      return { icon: 'warning', tint: 'warning', title, body: null, pillLabel: title, busy: false };
    }
    case 'active':
      return resolveOutagePresentation(state, t);
    case 'hidden':
      // Unreachable in practice — the caller returns early on `hidden` — but a
      // total function beats a non-null assertion here.
      return {
        icon: 'offline.unavailable',
        tint: 'none',
        title: t('mobile.connectivity.noSignal.title'),
        body: null,
        pillLabel: t('mobile.connectivity.noSignal.pill'),
        busy: false,
      };
  }
}

function resolveOutagePresentation(
  state: Extract<BannerState, { kind: 'active' }>,
  t: TFunction<'common'>,
): BannerPresentation {
  switch (state.reason) {
    case 'offline_mode':
      return {
        icon: 'offline.unavailable',
        tint: 'primary',
        title: t('mobile.connectivity.offlineMode.title'),
        body: t('mobile.connectivity.offlineMode.body'),
        pillLabel: t('mobile.connectivity.offlineMode.pill'),
        busy: false,
      };
    case 'device_offline':
      // No tint: the climber's own status bar already tells them, so the card is
      // a reminder of what still works, not an alarm.
      return {
        icon: 'offline.unavailable',
        tint: 'none',
        title: t('mobile.connectivity.noSignal.title'),
        body: t('mobile.connectivity.noSignal.body'),
        pillLabel: t('mobile.connectivity.noSignal.pill'),
        busy: false,
      };
    case 'backend_unreachable':
      return {
        icon: 'server.unreachable',
        tint: 'warning',
        title: t('mobile.connectivity.serverDown.title'),
        // After a failed retry, say what happens next rather than repeating the
        // explanation they have already read.
        body:
          state.retry === 'stillDown'
            ? t('mobile.connectivity.serverDown.stillDown')
            : t('mobile.connectivity.serverDown.body'),
        pillLabel: t('mobile.connectivity.serverDown.pill'),
        busy: state.retry === 'inFlight',
      };
  }
}

function resolveActions({
  state,
  t,
  showsAccountUi,
  retry,
  stayOffline,
  goOnline,
  openSyncIssues,
}: {
  state: BannerState;
  t: TFunction<'common'>;
  showsAccountUi: boolean;
  retry: () => void;
  stayOffline: () => void;
  goOnline: () => void;
  openSyncIssues: () => void;
}): BannerAction[] {
  if (state.kind === 'needs_retry') {
    return [
      {
        key: 'sync-issues',
        label: t('mobile.connectivity.recovering.openSyncIssues'),
        onPress: openSyncIssues,
        variant: 'tonal',
        loading: false,
      },
    ];
  }
  if (state.kind !== 'active') return [];

  if (state.reason === 'offline_mode') {
    if (!showsAccountUi) return [];
    return [
      {
        key: 'go-online',
        label: t('mobile.connectivity.offlineMode.goOnline'),
        onPress: goOnline,
        variant: 'tonal',
        loading: false,
      },
    ];
  }

  if (state.reason === 'backend_unreachable') {
    const actions: BannerAction[] = [
      {
        key: 'retry',
        label: t('mobile.connectivity.serverDown.retry'),
        onPress: retry,
        variant: 'tonal',
        loading: state.retry === 'inFlight',
      },
    ];
    if (showsAccountUi) {
      actions.push({
        key: 'stay-offline',
        label: t('mobile.connectivity.serverDown.stayOffline'),
        onPress: stayOffline,
        variant: 'text',
        loading: false,
      });
    }
    return actions;
  }

  // device_offline: nothing we can do from here that the climber cannot see for
  // themselves, so the card explains what still works and offers no button.
  return [];
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    left: spacing[3],
    right: spacing[3],
    alignItems: 'center',
    // Above the tab bar / native accessory in z-order. The root view paints this
    // sibling after the navigator, so it already stacks on top; the explicit
    // elevation/zIndex keeps it above the JS PersistentQueueBar on Android too.
    zIndex: 100,
    elevation: 100,
  },
  card: {
    width: '100%',
    maxWidth: MAX_BANNER_WIDTH,
    alignSelf: 'center',
    borderRadius: borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing[4],
    gap: spacing[2],
    overflow: 'hidden',
  },
  pill: {
    maxWidth: MAX_BANNER_WIDTH,
    alignSelf: 'center',
    borderRadius: borderRadius.full,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  pillPressable: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingVertical: spacing[2],
    paddingHorizontal: spacing[4],
  },
  badge: {
    minWidth: 22,
    alignItems: 'center',
    paddingHorizontal: spacing[2],
    paddingVertical: spacing[0],
    borderRadius: borderRadius.full,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing[2],
  },
  message: {
    flex: 1,
    gap: spacing[1],
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  title: {
    flexShrink: 1,
  },
  close: {
    padding: spacing[1],
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing[2],
  },
});
