import { memo, useCallback, useEffect } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { Text } from './Text';
import { Icon } from './Icon';
import { Button } from './Button';
import { track } from '../lib/analytics';
import { nowMs } from '../lib/clock';
import { useProfile } from '../lib/graphql/hooks';
import { getFirstConnectSnapshot } from '../lib/onboarding/first-connect-store';
import {
  dismissSavedClimbsCard,
  ensureSaveNextSessionLoaded,
  useSaveNextSessionSelector,
} from '../lib/save-next-session/save-next-session-store';
import { useHasSavedClimbsOnBoard } from '../lib/save-next-session/use-has-saved-climbs-on-board';
import { smartPlaylistHref } from '../lib/smart-playlists';
import { useFeatureFlagsResolved, useSaveNextSessionEnabled } from '../providers/feature-flags-provider';
import { useTheme } from '../providers/theme-provider';
import { selectByVariant } from '../theme/variants/select-by-variant';
import { borderRadius, spacing } from '../theme/tokens';

type SavedClimbsCardProps = {
  /** The active board's type (`kilter`, `tension`, ...), or null with no board. */
  boardType: string | null;
  /**
   * Another header card or one-shot tip has the slot (the connect card, the
   * board-reveal tip, the quick-actions tip). One at a time: this card waits.
   */
  suppressed: boolean;
  /** Layout (margins) from the host list. */
  style?: StyleProp<ViewStyle>;
};

// `Saved Climbs Card Shown` is a once-per-launch event, and the Climbs list
// remounts its header on every board switch and tab return.
let shownTrackedThisLaunch = false;

/**
 * The way back to hearted climbs (#6002): a card at the top of the Climbs list
 * with one action, "See saved climbs", and an X.
 *
 * Shown while the active board has at least one liked climb, until the X is
 * tapped (for good on this phone). It carries no number: the only count the app
 * has is across every board, and the card must not promise climbs the list
 * then shows for a different wall.
 *
 * Self-gating: outside its conditions it renders nothing, and the request for
 * the liked list is only mounted once the cheap checks (kill switch, dismissed,
 * a board, the slot being free) have passed.
 */
function SavedClimbsCardComponent({ boardType, suppressed, style }: SavedClimbsCardProps) {
  const enabled = useSaveNextSessionEnabled();
  const flagsResolved = useFeatureFlagsResolved();
  // A boolean, not the state: the Climbs list re-renders only when the answer
  // flips, not when the play drawer counts a notice. Unread state is "not yet".
  const notDismissed = useSaveNextSessionSelector((current) => current !== null && current.cardDismissedAt === null);
  useEffect(() => {
    ensureSaveNextSessionLoaded();
  }, []);

  if (!enabled || !flagsResolved || !notDismissed || suppressed || boardType === null) return null;
  return <SavedClimbsCardBody boardType={boardType} style={style} />;
}

type SavedClimbsCardBodyProps = {
  boardType: string;
  style?: StyleProp<ViewStyle>;
};

function SavedClimbsCardBody({ boardType, style }: SavedClimbsCardBodyProps) {
  const { t } = useTranslation('playlists');
  const { variant, systemColors, brandColors, m3SurfaceContainers } = useTheme();
  const { data: profile } = useProfile();
  const visible = useHasSavedClimbsOnBoard({ userId: profile?.id ?? null, boardType });

  useEffect(() => {
    if (!visible || shownTrackedThisLaunch) return;
    shownTrackedThisLaunch = true;
    const device = getFirstConnectSnapshot().device;
    track(SHARED_EVENTS.SavedClimbsCardShown, {
      board_type: boardType,
      phone_has_connected: device ? device.connectedAt !== null : null,
    });
  }, [visible, boardType]);

  const handleOpen = useCallback(() => {
    track(SHARED_EVENTS.SavedClimbsCardAction, { action: 'open', board_type: boardType });
    // Cross-tab push: `withAnchor` loads the Discover library underneath when
    // that tab was never opened, so back (and the tab itself) has somewhere to go.
    router.push(smartPlaylistHref('LIKED_CLIMBS', 'saved_card'), { withAnchor: true });
  }, [boardType]);

  const handleDismiss = useCallback(() => {
    track(SHARED_EVENTS.SavedClimbsCardAction, { action: 'dismiss', board_type: boardType });
    void dismissSavedClimbsCard(nowMs());
  }, [boardType]);

  if (!visible) return null;

  const surface = selectByVariant(variant, {
    liquidGlass: { backgroundColor: systemColors.secondaryBackground },
    material: { backgroundColor: m3SurfaceContainers.high },
  });

  return (
    <View style={[styles.surface, surface, style]}>
      <View style={styles.header}>
        <Icon name="favorite.fill" size={22} color={brandColors.primary} />
        <View style={styles.text}>
          <Text variant="headline" accessibilityRole="header">
            {t('library.savedCard.title')}
          </Text>
          <Text variant="subheadline" color={systemColors.secondaryLabel}>
            {t('library.savedCard.body')}
          </Text>
        </View>
        <Pressable
          onPress={handleDismiss}
          accessibilityRole="button"
          accessibilityLabel={t('library.savedCard.dismiss')}
          hitSlop={8}
          style={styles.close}
        >
          <Icon name="close" size={16} color={systemColors.secondaryLabel} />
        </Pressable>
      </View>
      <View style={styles.actions}>
        <Button title={t('library.savedCard.open')} variant="filled" size="small" onPress={handleOpen} />
      </View>
    </View>
  );
}

export const SavedClimbsCard = memo(SavedClimbsCardComponent);

/** Test-only: a fresh launch for the once-per-launch `Shown` event. */
export function resetSavedClimbsCardForTests(): void {
  if (process.env.NODE_ENV !== 'test') return;
  shownTrackedThisLaunch = false;
}

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
