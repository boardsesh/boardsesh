// What the play drawer's SECOND action row shows while a browse latch is up:
// leave the latch, or put the climb you're looking at on the wall.
//
// It swaps the row's CONTENT (angle pill, heart, more, share, queue) rather than
// adding a band, so the drawer's height is untouched — the whole point of the
// preview-first work is giving board art back, not spending it on chrome. The
// utilities are gone for the duration on purpose: browsing is a transient
// choosing state, and the primary row above still acts on the displayed climb.
//
// The busy-wall confirm re-uses the same two controls IN PLACE rather than
// growing a dialog: the pair crossfades to "Keep theirs" / "Put mine up" and the
// question floats above them as a bubble. Both actions are the ones the row
// already had — the second tap on the filled button is the commit, and the text
// button is still the exit — so nothing new can be tapped by accident, and the
// row's geometry never moves under a thumb that is already on its way down.

import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, useReducedMotion } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../providers/theme-provider';
import { androidRipple, spacing, borderRadius, shadows } from '../../theme/tokens';
import { withAlpha } from '../../theme/colors';
import { selectByVariant } from '../../theme/variants/select-by-variant';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import { glassSize } from '../../theme/layout';
import { drawerActionBarStyles } from '../drawer-action-bar/DrawerActionBar';
import { Text } from '../Text';
import { Icon } from '../Icon';
import type { CommitButtonLabel } from './wall-state';

/** Matches the row's own control height, so the bubble clears the buttons. */
const BUBBLE_LIFT = glassSize.inline + spacing[1];
const BUBBLE_ICON_SIZE = 14;
const SWAP_FADE_MS = 150;
const BUBBLE_FADE_MS = 180;

type PlayDrawerCommitBarProps = {
  showBackToLive: boolean;
  /** Hidden (never disabled-dead) when the displayed climb is already the lit one. */
  showPutOnWall: boolean;
  /**
   * Someone else moved the wall while this climber was browsing. The pair swaps
   * to Keep theirs / Put mine up and the question floats above it. Never true at
   * the same time as the two flags above — `resolveCommitBarModel` owns that.
   */
  showConfirm: boolean;
  /** The climb the wall is showing — named in the confirm's question. */
  wallClimbName: string | null;
  /**
   * "Put on the wall" where a wall is actually reachable, "Set active" where none
   * is — the button never promises a lighting it can't do.
   */
  commitLabel: CommitButtonLabel;
  /** Leaves the latch. Doubles as "Keep theirs": both land the climber back on
   *  the committed climb with the wall untouched, which is the same act. */
  onBackToLive: () => void;
  /** Commits the displayed climb. The FIRST tap is what armed the confirm, so
   *  the second one goes straight through — the host owns that ladder. */
  onCommit: () => void;
};

function PlayDrawerCommitBarImpl({
  showBackToLive,
  showPutOnWall,
  showConfirm,
  wallClimbName,
  commitLabel,
  onBackToLive,
  onCommit,
}: PlayDrawerCommitBarProps) {
  const { t } = useTranslation('session');
  const { variant, brandColors, systemColors, m3SurfaceContainers, materialElevation, radii } = useTheme();
  const reduceMotion = useReducedMotion();

  const commitText = commitLabel === 'putOnWall' ? t('playView.wallState.putOnWall') : t('playView.setActive');
  const exitText = showConfirm ? t('playView.wallState.commitOverride.cancel') : t('playView.wallState.backToLive');
  const confirmText = showConfirm ? t('playView.wallState.commitOverride.confirm') : commitText;
  // In confirm mode BOTH controls are the answer to the question, so neither
  // flag applies — the pair is the decision.
  const showExit = showConfirm || showBackToLive;
  const showFilled = showConfirm || showPutOnWall;

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
          pushing it. Untouchable on purpose — the two buttons below are the only
          answers — but left readable, because TalkBack hears it from this polite
          live region while VoiceOver hears the host's announcement.

          The region itself is mounted for the whole life of the row and sits
          empty while browsing, so arming the confirm is a CONTENT CHANGE inside
          it — which is the thing Android announces. A region that first appears
          already holding its sentence is not a change, and TalkBack can pass over
          it in silence. It has no surface of its own and is absolutely
          positioned, so an empty one costs nothing. */}
      <View accessibilityLiveRegion="polite" pointerEvents="none" style={styles.bubbleRegion}>
        {showConfirm ? (
          <Animated.View
            entering={reduceMotion ? undefined : FadeIn.duration(BUBBLE_FADE_MS)}
            style={[styles.bubble, ...bubbleSurface]}
          >
            <Icon name="warning" size={BUBBLE_ICON_SIZE} color={brandColors.live} />
            <Text variant="caption1" color={systemColors.label} numberOfLines={2} style={styles.bubbleText}>
              {t('playView.wallState.commitOverride.body', { name: wallClimbName ?? '' })}
            </Text>
          </Animated.View>
        ) : null}
      </View>

      {/* Keyed on the mode so the swap is a crossfade in place, not a relayout:
          "Put mine up" lands exactly where "Put on the wall" was. */}
      <Animated.View
        key={showConfirm ? 'confirm' : 'browse'}
        entering={reduceMotion ? undefined : FadeIn.duration(SWAP_FADE_MS)}
        style={styles.controls}
      >
        {showExit ? (
          <Pressable
            onPress={onBackToLive}
            accessibilityRole="button"
            accessibilityLabel={exitText}
            style={({ pressed }) => [styles.textButton, pressed && drawerActionBarStyles.actionButtonPressed]}
          >
            <Text
              variant="subheadline"
              color={brandColors.tint}
              numberOfLines={1}
              maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
              style={styles.textButtonLabel}
            >
              {exitText}
            </Text>
          </Pressable>
        ) : null}

        <View style={drawerActionBarStyles.spacer} />

        {showFilled ? (
          <Pressable
            onPress={onCommit}
            accessibilityRole="button"
            accessibilityLabel={confirmText}
            android_ripple={androidRipple(brandColors.onPrimary)}
            style={({ pressed }) => [
              styles.filledButton,
              { backgroundColor: brandColors.primaryFill, borderRadius: radii.button },
              pressed && styles.filledButtonPressed,
            ]}
          >
            <Text
              variant="subheadline"
              color={brandColors.onPrimary}
              numberOfLines={1}
              maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
              style={styles.filledButtonLabel}
            >
              {confirmText}
            </Text>
          </Pressable>
        ) : null}
      </Animated.View>
    </View>
  );
}

export const PlayDrawerCommitBar = memo(PlayDrawerCommitBarImpl);

const styles = StyleSheet.create({
  // Fills the secondary row it replaces, so the row's own 64pt geometry (44pt
  // controls + 8/12 padding) is untouched.
  row: {
    flex: 1,
  },
  controls: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  // The live region's own box: no surface, no size of its own, so it costs
  // nothing while it sits empty waiting for the question.
  bubbleRegion: {
    position: 'absolute',
    bottom: BUBBLE_LIFT,
    right: 0,
    maxWidth: '85%',
    alignItems: 'flex-end',
  },
  bubble: {
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
    // German's "Am Board beleuchten" is 19 characters — let the button give
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
