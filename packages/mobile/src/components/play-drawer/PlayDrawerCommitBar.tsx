import { PressableSurface } from '../PressableSurface';
// The browse latch's controls in the play drawer's second action row.
//
// While a climber looks around, the row keeps its usual buttons and
// `PutOnWallButton` sits in the gap in the middle: the one thing that sends what
// they're looking at to the wall. Going back is the face chip in the header.
//
// Only the busy-wall question takes the whole row (`PlayDrawerCommitBar`):
// someone else lit the wall while you looked around, so the next tap would
// replace their climb. The pair reads "Keep Sam's" / "Put mine up" and the
// question floats above it as a bubble. "Put mine up" sits in the middle,
// exactly where Put on the wall was, so the second tap is the commit and nothing
// new can be hit by accident.

import { memo, useEffect, useRef } from 'react';
import { AccessibilityInfo, Platform, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, useReducedMotion } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../providers/theme-provider';
import { androidRipple, spacing, borderRadius, shadows } from '../../theme/tokens';
import { withAlpha } from '../../theme/colors';
import { selectByVariant } from '../../theme/variants/select-by-variant';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import { glassSize } from '../../theme/layout';
import { drawerActionBarStyles } from '../drawer-action-bar/DrawerActionBar';
import { LargeContentViewer } from '../LargeContentViewer';
import { Text } from '../Text';
import { Icon } from '../Icon';
import type { CommitButtonLabel } from './wall-state';
import { useQueueData, useQueueLiveStats, useQueueSessionControls } from '../../providers/queue-provider';
import { resolveCurrentClimbMoverName } from '../../lib/current-climb-mover';

/** Matches the row's own control height, so the bubble clears the buttons. */
const BUBBLE_LIFT = glassSize.inline + spacing[1];
const BUBBLE_ICON_SIZE = 14;
const BUBBLE_FADE_MS = 180;

type FilledButtonProps = {
  label: string;
  onPress: () => void;
};

/** The brand-filled capsule both controls share, so Put mine up lands where Put on the wall was. */
function FilledButton({ label, onPress }: FilledButtonProps) {
  const { brandColors, radii } = useTheme();
  return (
    <PressableSurface
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      android_ripple={androidRipple(brandColors.onPrimary)}
      style={({ pressed }) => [
        styles.filledButton,
        { backgroundColor: brandColors.primaryFill, borderRadius: radii.button },
        pressed && styles.filledButtonPressed,
      ]}
    >
      <LargeContentViewer title={label} onActivate={onPress}>
        <Text
          variant="subheadline"
          color={brandColors.onPrimary}
          numberOfLines={1}
          maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
          style={styles.filledButtonLabel}
        >
          {label}
        </Text>
      </LargeContentViewer>
    </PressableSurface>
  );
}

type PutOnWallButtonProps = {
  /** "Put on the wall" where a wall is reachable, "Set active" where none is. */
  commitLabel: CommitButtonLabel;
  onPress: () => void;
};

/** Sends the climb on screen to the wall. Shown only while it isn't the lit one. */
export const PutOnWallButton = memo(function PutOnWallButton({ commitLabel, onPress }: PutOnWallButtonProps) {
  const { t } = useTranslation('session');
  const label = commitLabel === 'putOnWall' ? t('playView.wallState.putOnWall') : t('playView.setActive');
  return <FilledButton label={label} onPress={onPress} />;
});

type PlayDrawerCommitBarProps = {
  /** The climb the wall is showing, named in the question. */
  wallClimbName: string | null;
  /** Its uuid, to check the crew's current climb is the one that's lit. */
  wallClimbUuid: string | null;
  /** Leave their climb up and go back to it. Nothing is sent. */
  onKeepTheirs: () => void;
  /** The second tap: put the climb on screen up over theirs. */
  onConfirm: () => void;
};

/** The busy-wall question: someone else lit the wall while you were looking around. */
function PlayDrawerCommitBarImpl({ wallClimbName, wallClimbUuid, onKeepTheirs, onConfirm }: PlayDrawerCommitBarProps) {
  const { t } = useTranslation('session');
  // Queue authorship and the phone holding Bluetooth do not identify the mover.
  // Read the roster only while this question is mounted.
  const { currentClimbQueueItem, currentChangedBy } = useQueueData();
  const { participantId } = useQueueSessionControls();
  const { sessionUsers } = useQueueLiveStats();
  const wallDriverName =
    wallClimbUuid !== null && currentClimbQueueItem?.climb.uuid === wallClimbUuid
      ? resolveCurrentClimbMoverName({ currentChangedBy, participantId, sessionUsers })
      : null;
  const { variant, brandColors, systemColors, m3SurfaceContainers, materialElevation } = useTheme();
  const reduceMotion = useReducedMotion();

  const climbName = wallClimbName ?? '';
  const question = wallDriverName
    ? t('playView.wallState.commitOverride.bodyNamed', { person: wallDriverName, name: climbName })
    : t('playView.wallState.commitOverride.body', { name: climbName });
  const keepText = wallDriverName
    ? t('playView.wallState.commitOverride.cancelNamed', { person: wallDriverName })
    : t('playView.wallState.commitOverride.cancel');
  const confirmText = t('playView.wallState.commitOverride.confirm');

  // The row mounts the moment the question arms, so mounting is the moment to
  // say it, on both platforms: a live region that mounts already holding its
  // text is not a content change, so TalkBack can pass over it. After that the
  // question can still change (the name resolves, someone lights another
  // climb); Android's live region below reads those, so only iOS repeats it.
  const announcedRef = useRef(false);
  useEffect(() => {
    if (announcedRef.current && Platform.OS === 'android') return;
    announcedRef.current = true;
    AccessibilityInfo.announceForAccessibility(question);
  }, [question]);

  const isMaterial = selectByVariant(variant, { material: true, liquidGlass: false });
  const bubbleSurface = isMaterial
    ? [{ backgroundColor: m3SurfaceContainers.high }, materialElevation.level2]
    : [
        {
          backgroundColor: systemColors.elevatedSurface,
          borderWidth: StyleSheet.hairlineWidth,
          // The connected-light semantic: this is a statement about the wall.
          borderColor: withAlpha(brandColors.live, 0.35),
        },
        shadows.sm,
      ];

  return (
    <View style={styles.row}>
      {/* Zero layout shift: the question floats ABOVE the row rather than
          pushing it. Untouchable on purpose (the two buttons below are the only
          answers) but readable: the effect above speaks it once on mount, and
          the polite live region catches a change while it stays up (another
          climber lighting yet another climb renames it). */}
      <View accessibilityLiveRegion="polite" pointerEvents="none" style={styles.bubbleRegion}>
        <Animated.View
          entering={reduceMotion ? undefined : FadeIn.duration(BUBBLE_FADE_MS)}
          style={[styles.bubble, ...bubbleSurface]}
        >
          <Icon name="warning" size={BUBBLE_ICON_SIZE} color={brandColors.live} />
          <Text variant="caption1" color={systemColors.label} numberOfLines={2} style={styles.bubbleText}>
            {question}
          </Text>
        </Animated.View>
      </View>

      {/* Put mine up sits in the middle, exactly where Put on the wall was, so
          the second tap on the same spot is the commit. Keep takes the left
          half and gives ground (truncates) before it can reach the middle. */}
      <View style={styles.controls}>
        <View style={styles.side}>
          <PressableSurface
            onPress={onKeepTheirs}
            accessibilityRole="button"
            accessibilityLabel={keepText}
            style={({ pressed }) => [styles.textButton, pressed && drawerActionBarStyles.actionButtonPressed]}
          >
            <LargeContentViewer title={keepText} onActivate={onKeepTheirs}>
              <Text
                variant="subheadline"
                color={brandColors.tint}
                numberOfLines={1}
                maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
                style={styles.textButtonLabel}
              >
                {keepText}
              </Text>
            </LargeContentViewer>
          </PressableSurface>
        </View>

        <FilledButton label={confirmText} onPress={onConfirm} />

        <View style={styles.side} />
      </View>
    </View>
  );
}

export const PlayDrawerCommitBar = memo(PlayDrawerCommitBarImpl);

const styles = StyleSheet.create({
  // Fills the second row it replaces. The host row is horizontal, so `flex`
  // only widens this column; its height has to come from `minHeight`.
  row: {
    flex: 1,
    minHeight: glassSize.inline,
  },
  // `flexGrow`, never `flex: 1`: in RN that sets flexBasis 0, which collapsed
  // this content-sized row to 0pt and let the 44pt buttons spill over the bar
  // above it.
  controls: {
    flexGrow: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  // Two equal halves either side of the filled button keep it centred.
  side: {
    flex: 1,
    alignItems: 'flex-start',
  },
  // The live region's own box: no surface and no size of its own.
  // Centred over Put mine up, which sits in the middle of the row.
  bubbleRegion: {
    position: 'absolute',
    bottom: BUBBLE_LIFT,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  bubble: {
    maxWidth: '85%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderRadius: borderRadius.md,
  },
  bubbleText: {
    flexShrink: 1,
  },
  textButton: {
    height: glassSize.inline,
    justifyContent: 'center',
    paddingHorizontal: spacing[2],
    flexShrink: 1,
  },
  textButtonLabel: {
    fontWeight: '600',
  },
  filledButton: {
    height: glassSize.inline,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing[5],
    // German's "Am Board beleuchten" is 19 characters: let the button give
    // ground before the label truncates on a 375pt screen.
    flexShrink: 1,
    overflow: 'hidden',
  },
  filledButtonPressed: {
    opacity: 0.6,
    transform: [{ scale: 0.92 }],
  },
  filledButtonLabel: {
    fontWeight: '600',
    flexShrink: 1,
  },
});
