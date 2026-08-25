// What the play drawer's SECOND action row shows while a browse latch is up:
// leave the latch, or put the climb you're looking at on the wall.
//
// It swaps the row's CONTENT (angle pill, heart, more, share, queue) rather than
// adding a band, so the drawer's height is untouched — the whole point of the
// preview-first work is giving board art back, not spending it on chrome. The
// utilities are gone for the duration on purpose: browsing is a transient
// choosing state, and the primary row above still acts on the displayed climb.

import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, useReducedMotion } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../providers/theme-provider';
import { androidRipple, spacing } from '../../theme/tokens';
import { CHROME_LABEL_MAX_FONT_SCALE } from '../../theme/typography';
import { glassSize } from '../../theme/layout';
import { drawerActionBarStyles } from '../drawer-action-bar/DrawerActionBar';
import { Text } from '../Text';
import type { CommitButtonLabel } from './wall-state';

type PlayDrawerCommitBarProps = {
  showBackToLive: boolean;
  /** Hidden (never disabled-dead) when the displayed climb is already the lit one. */
  showPutOnWall: boolean;
  /**
   * "Put on the wall" where a wall is actually reachable, "Set active" where none
   * is — the button never promises a lighting it can't do.
   */
  commitLabel: CommitButtonLabel;
  onBackToLive: () => void;
  onCommit: () => void;
};

function PlayDrawerCommitBarImpl({
  showBackToLive,
  showPutOnWall,
  commitLabel,
  onBackToLive,
  onCommit,
}: PlayDrawerCommitBarProps) {
  const { t } = useTranslation('session');
  const { brandColors, radii } = useTheme();
  const reduceMotion = useReducedMotion();

  const commitText = commitLabel === 'putOnWall' ? t('playView.wallState.putOnWall') : t('playView.setActive');

  return (
    <Animated.View entering={reduceMotion ? undefined : FadeIn.duration(150)} style={styles.row}>
      {showBackToLive ? (
        <Pressable
          onPress={onBackToLive}
          accessibilityRole="button"
          accessibilityLabel={t('playView.wallState.backToLive')}
          style={({ pressed }) => [styles.textButton, pressed && drawerActionBarStyles.actionButtonPressed]}
        >
          <Text
            variant="subheadline"
            color={brandColors.tint}
            numberOfLines={1}
            maxFontSizeMultiplier={CHROME_LABEL_MAX_FONT_SCALE}
            style={styles.textButtonLabel}
          >
            {t('playView.wallState.backToLive')}
          </Text>
        </Pressable>
      ) : null}

      <View style={drawerActionBarStyles.spacer} />

      {showPutOnWall ? (
        <Pressable
          onPress={onCommit}
          accessibilityRole="button"
          accessibilityLabel={commitText}
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
            {commitText}
          </Text>
        </Pressable>
      ) : null}
    </Animated.View>
  );
}

export const PlayDrawerCommitBar = memo(PlayDrawerCommitBarImpl);

const styles = StyleSheet.create({
  // Fills the secondary row it replaces, so the row's own 64pt geometry (44pt
  // controls + 8/12 padding) is untouched.
  row: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
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
