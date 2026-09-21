import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Button } from '../Button';
import { useLightbulbControl } from '../ble/use-lightbulb-control';
import { track } from '../../lib/analytics';
import { nowMs } from '../../lib/clock';
import { reportError } from '../../lib/error-reporting';
import { isConnectStepTreatmentLive, shouldShowFirstConnectCard } from '../../lib/onboarding/first-connect-decision';
import {
  FIRST_CONNECT_LAUNCH_ID,
  dismissFirstConnectCardForLaunch,
  markFirstConnectNoLights,
  recordFirstConnectCardLaunch,
  useFirstConnectSnapshot,
} from '../../lib/onboarding/first-connect-store';
import { useFirstConnectCtaEnabled } from '../../providers/feature-flags-provider';
import { useTheme } from '../../providers/theme-provider';
import { selectByVariant } from '../../theme/variants/select-by-variant';
import { borderRadius, spacing } from '../../theme/tokens';

type ConnectAttempt = 'idle' | 'connecting' | 'failed';
type FirstRunCardAction = 'connect' | 'no_lights' | 'dismiss' | 'retry';

type FirstConnectCardProps = {
  /** The bound board's name, or null when there is none to show. */
  boardName: string | null;
  /** A board is bound and not flagged as having no lights (`hasLeds !== false`). */
  boardHasLights: boolean;
  /** Layout (margins) from the host list. */
  style?: StyleProp<ViewStyle>;
};

function trackCardAction(action: FirstRunCardAction): void {
  track(SHARED_EVENTS.FirstRunCardAction, { action });
}

/**
 * The connect-step test's Climbs card (#5654, PR 7, treatment only): "Light
 * climbs on {{board}}", with **Connect**, **This wall has no lights** and an X
 * ("Not now").
 *
 * Shown while a board with lights is bound and this phone has never connected,
 * on at most two launches. The X hides it for this launch; "no lights" hides it
 * (and the play-view pill) for good on this phone, without touching the board's
 * `hasLeds`. Connect runs exactly what the play view's bulb runs for a connect
 * (`bluetooth.connect` with the remembered board, after arming the undo toast),
 * so a connect from here is the same connect with a label on it. A cancelled or
 * failed connect keeps the card up with "Try again".
 *
 * Self-gating: renders nothing outside the treatment. Opaque on Liquid Glass
 * (glass stays on the chrome) and tonal on Material.
 */
function FirstConnectCardComponent({ boardName, boardHasLights, style }: FirstConnectCardProps) {
  const { device, enrolment } = useFirstConnectSnapshot();
  const enabled = useFirstConnectCtaEnabled();
  // Only the treatment mounts the body, so every other climber pays for one
  // store read here and none of the Bluetooth and presence subscriptions.
  const live = boardHasLights && isConnectStepTreatmentLive({ enrolment, enabled, device });
  if (!live) return null;
  return <FirstConnectCardBody boardName={boardName} boardHasLights={boardHasLights} style={style} />;
}

/**
 * Whether the card is due on Climbs, from the store alone (no Bluetooth or
 * presence reads), so the list can hold its one-shot tips back while the card
 * has the slot. The card itself also stands down while someone else drives the
 * wall; the tips wait then too, which costs nothing.
 */
export function useFirstConnectCardExpected(boardHasLights: boolean): boolean {
  const { device, enrolment, cardDismissedThisLaunch } = useFirstConnectSnapshot();
  const enabled = useFirstConnectCtaEnabled();
  return shouldShowFirstConnectCard({
    treatmentLive: isConnectStepTreatmentLive({ enrolment, enabled, device }),
    boardHasLights,
    dismissedThisLaunch: cardDismissedThisLaunch,
    launchId: FIRST_CONNECT_LAUNCH_ID,
    cardLaunchIds: device?.cardLaunchIds ?? [],
    wallFree: true,
  });
}

function FirstConnectCardBody({ boardName, boardHasLights, style }: FirstConnectCardProps) {
  const { t } = useTranslation('boards');
  const { variant, systemColors, brandColors, m3SurfaceContainers } = useTheme();
  const { device, enrolment, cardDismissedThisLaunch } = useFirstConnectSnapshot();
  const enabled = useFirstConnectCtaEnabled();
  const { bluetooth, pressAction, pending, holderIsAuthoritative, onPress } = useLightbulbControl();
  const [attempt, setAttempt] = useState<ConnectAttempt>('idle');
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const treatmentLive = isConnectStepTreatmentLive({ enrolment, enabled, device });
  const visible = shouldShowFirstConnectCard({
    treatmentLive,
    boardHasLights,
    dismissedThisLaunch: cardDismissedThisLaunch,
    launchId: FIRST_CONNECT_LAUNCH_ID,
    cardLaunchIds: device?.cardLaunchIds ?? [],
    wallFree: !holderIsAuthoritative && !(bluetooth?.wallHeldByOtherUser ?? false),
  });

  // Counts this launch against the card's two. A launch it already appeared on
  // keeps it, so recording never hides the card it was recorded for.
  useEffect(() => {
    if (visible) void recordFirstConnectCardLaunch(FIRST_CONNECT_LAUNCH_ID);
  }, [visible]);

  const runConnect = useCallback(
    async (action: 'connect' | 'retry') => {
      trackCardAction(action);
      AccessibilityInfo.announceForAccessibility(
        boardName
          ? t('mobile.firstConnect.card.connecting', { board: boardName })
          : t('mobile.firstConnect.card.connectingNoName'),
      );
      // Anything but a plain connect (a peer took the wall a moment ago) goes
      // through the bulb's own ladder, which knows what to do with it.
      if (!bluetooth || pressAction !== 'connect') {
        onPress();
        return;
      }
      setAttempt('connecting');
      bluetooth.armUndoWallChangeToast();
      let connected = false;
      try {
        connected = await bluetooth.connect(
          undefined,
          undefined,
          bluetooth.reconnectSerialForCurrentBoard ?? undefined,
          bluetooth.reconnectDeviceIdForCurrentBoard ?? undefined,
        );
      } catch (error: unknown) {
        reportError(error);
      }
      if (mountedRef.current) setAttempt(connected ? 'idle' : 'failed');
    },
    [bluetooth, pressAction, onPress, boardName, t],
  );
  const handleConnect = useCallback(() => {
    void runConnect(attempt === 'failed' ? 'retry' : 'connect');
  }, [runConnect, attempt]);

  const handleNoLights = useCallback(() => {
    trackCardAction('no_lights');
    track(SHARED_EVENTS.BoardLightsDeclined, { surface: 'climbs_card' });
    void markFirstConnectNoLights(nowMs());
  }, []);

  const handleDismiss = useCallback(() => {
    trackCardAction('dismiss');
    dismissFirstConnectCardForLaunch();
  }, []);

  if (!visible) return null;

  const busy = pending || attempt === 'connecting';
  const surface = selectByVariant(variant, {
    liquidGlass: { backgroundColor: systemColors.secondaryBackground },
    material: { backgroundColor: m3SurfaceContainers.high },
  });
  const title = boardName
    ? t('mobile.firstConnect.card.title', { board: boardName })
    : t('mobile.firstConnect.card.titleNoName');

  return (
    <View style={[styles.surface, surface, style]}>
      <View style={styles.header}>
        <Icon name="lightbulb.fill" size={22} color={brandColors.primary} />
        <View style={styles.text}>
          <Text variant="headline" accessibilityRole="header">
            {title}
          </Text>
          <Text variant="subheadline" color={systemColors.secondaryLabel}>
            {t('mobile.firstConnect.card.body')}
          </Text>
        </View>
        <Pressable
          onPress={handleDismiss}
          accessibilityRole="button"
          accessibilityLabel={t('mobile.firstConnect.card.notNow')}
          hitSlop={8}
          style={styles.close}
        >
          <Icon name="close" size={16} color={systemColors.secondaryLabel} />
        </Pressable>
      </View>
      {attempt === 'failed' ? (
        <Text variant="footnote" color={systemColors.secondaryLabel} accessibilityLiveRegion="polite">
          {boardName
            ? t('mobile.firstConnect.card.failed', { board: boardName })
            : t('mobile.firstConnect.card.failedNoName')}
        </Text>
      ) : null}
      <View style={styles.actions}>
        <Button
          title={attempt === 'failed' ? t('mobile.firstConnect.card.tryAgain') : t('mobile.firstConnect.card.connect')}
          variant="filled"
          size="small"
          icon="lightbulb"
          loading={busy}
          disabled={busy}
          onPress={handleConnect}
        />
        <Button title={t('mobile.firstConnect.card.noLights')} variant="text" size="small" onPress={handleNoLights} />
      </View>
    </View>
  );
}

export const FirstConnectCard = memo(FirstConnectCardComponent);

const styles = StyleSheet.create({
  surface: {
    borderRadius: borderRadius.lg,
    padding: spacing[3],
    gap: spacing[2],
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing[2],
  },
  text: {
    flex: 1,
    gap: spacing[1],
  },
  close: {
    padding: spacing[1],
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing[2],
  },
});
