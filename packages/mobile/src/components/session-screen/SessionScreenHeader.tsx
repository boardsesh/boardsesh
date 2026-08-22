import { Pressable, StyleSheet, View } from 'react-native';
import { GestureDetector, type PanGesture } from 'react-native-gesture-handler';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';

type SessionScreenHeaderProps = {
  /** Minimize handler (chevron-down). Absent in tab mode — switching tabs minimizes. */
  onClose?: () => void;
  sessionActive: boolean;
  /** When set, a share button floats at the trailing edge to invite climbers. */
  onShare?: () => void;
  /** When set (session live), a labelled exit control (icon + "Stop" / "Leave")
   *  docks beside share so the overlay matches the tab chrome's trailing exit. */
  onEndSession?: () => void;
  /**
   * What this device's exit actually does — `end` (destructive red stop) or
   * `leave` (neutral drop-out). Mirrors RecordTopChrome's prop of the same
   * name so the overlay strip and the tab chrome can't disagree about what the
   * button will do (#3502). Defaults to `end` for callers that don't know.
   */
  exitVariant?: 'end' | 'leave';
  /**
   * Show a short "Invite" label beside the share glyph to teach the affordance.
   * Set while the climber is solo; collapses to the icon alone once a friend
   * joins (a clear contextual label, the HIG-preferred alternative to a coachmark).
   */
  inviteHint?: boolean;
  /**
   * Swipe-down-to-dismiss gesture (the header doubles as the drag handle).
   * Absent in tab mode, where the header isn't draggable.
   */
  dragGesture?: PanGesture;
};

/**
 * Compact header strip for the session screen. Left: chevron-down to minimize
 * in overlay mode (omitted in tab mode, where switching tabs is the minimize).
 * Center: contextual title. Right: a share button to invite climbers while a
 * session is live. In overlay mode the whole strip is also a drag handle —
 * swipe it down to dismiss; tab mode renders the same row without the gesture.
 */
export function SessionScreenHeader({
  onClose,
  sessionActive,
  onShare,
  onEndSession,
  inviteHint,
  dragGesture,
  exitVariant = 'end',
}: SessionScreenHeaderProps) {
  const { t } = useTranslation('session');
  const { systemColors, brandColors } = useTheme();

  const title = sessionActive ? t('mobile.session.headerActive') : t('mobile.session.headerStart');
  // Same split RecordTopChrome makes: leaving is non-destructive, so it gets
  // neither the red tint nor the stop glyph, and the accessibility label stays
  // the long-form string web's queue bar already ships.
  const isLeaveExit = exitVariant === 'leave';
  const exitLabel = isLeaveExit ? t('queueBar.ariaLabels.leaveSession') : t('mobile.session.inEndSession');
  // The word on the control. A bare flag glyph reads as "report this climb"
  // (#4281), so the overlay strip names its exit the way the tab chrome does.
  const exitActionLabel = isLeaveExit ? t('mobile.session.inLeave') : t('mobile.session.inStop');
  const exitTint = isLeaveExit ? systemColors.label : brandColors.error;

  const row = (
    <View style={styles.row}>
      {onClose ? (
        <Pressable
          onPress={onClose}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel={t('mobile.session.minimize')}
          style={styles.iconButton}
        >
          <Icon name="chevron.down" size={26} color={systemColors.label} />
        </Pressable>
      ) : (
        <View style={styles.iconButton} />
      )}
      <Text variant="title3" color={systemColors.label} style={styles.title} numberOfLines={1}>
        {title}
      </Text>
      {onShare || onEndSession ? (
        <View style={styles.rightCluster}>
          {onShare ? (
            <Pressable
              onPress={onShare}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel={t('mobile.session.invite')}
              style={styles.shareButton}
            >
              {inviteHint ? (
                <Text
                  variant="subheadline"
                  color={systemColors.label}
                  numberOfLines={1}
                  maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
                  style={styles.shareLabel}
                >
                  {t('mobile.session.inviteAction')}
                </Text>
              ) : null}
              <Icon name="share" size={22} color={systemColors.label} />
            </Pressable>
          ) : null}
          {onEndSession ? (
            // Icon + word, matching the Stop pill in RecordTopChrome — the two
            // surfaces show the same control for the same action, so neither can
            // be the one a climber has to guess at.
            <Pressable
              onPress={onEndSession}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel={exitLabel}
              style={styles.exitButton}
            >
              <Icon name={isLeaveExit ? 'leave.session' : 'flag'} size={22} color={exitTint} />
              <Text
                variant="subheadline"
                color={exitTint}
                numberOfLines={1}
                // The strip's controls are pinned to 40dp, so the label has to
                // stop growing before it clips.
                maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
                style={styles.exitLabel}
              >
                {exitActionLabel}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <View style={styles.iconButton} />
      )}
    </View>
  );

  // Tab mode: no drag handle, render the row directly.
  if (!dragGesture) {
    return row;
  }

  return <GestureDetector gesture={dragGesture}>{row}</GestureDetector>;
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  title: {
    flex: 1,
    textAlign: 'center',
    fontWeight: '600',
  },
  iconButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rightCluster: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  shareButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing[1],
    minWidth: 40,
    height: 40,
    paddingLeft: spacing[2],
  },
  shareLabel: {
    fontWeight: '600',
  },
  // Matches shareButton's metrics so the two right-cluster controls sit on one
  // baseline. 40dp tall + hitSlop 12 keeps the target well past 44pt.
  exitButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing[1],
    minWidth: 40,
    height: 40,
    paddingLeft: spacing[2],
  },
  exitLabel: {
    fontWeight: '600',
  },
});
