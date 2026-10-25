// The end of the list the player is walking (issue #6664, closing #3841).
//
// Swipes and Next walk the list a climb was tapped in, and at its last climb
// they stop. This card is what Next, or one more forward swipe, shows there:
// the list's name, and one way to carry on with the queue instead, naming the
// climb that comes first (#6238). It used to
// be that Next fell silently into whatever older climb sat in the queue.
//
// An anchored transient card over the board, NOT a sheet — the same reasoning
// as the wall-state callout: one decision about the climb on screen, with the
// board left visible behind it. It covers the board only, so the header and
// the action bar stay where they are (Previous still goes back along the list).
//
// Modal for assistive tech: the scrim and the card share one container that
// carries `accessibilityViewIsModal`, focus lands on the title on open, and
// Android hardware back closes it. The host closes it on any climb change.

import { memo, useEffect, useRef } from 'react';
import { BackHandler, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, useReducedMotion } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { PressableSurface } from '../PressableSurface';
import { Button } from '../Button';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, overlays, shadows, spacing } from '../../theme/tokens';
import { selectByVariant } from '../../theme/variants/select-by-variant';
import { useAnnounceBodyFocus } from './use-announce-body-focus';
import type { TrackEndCardModel } from './track-end';

/** Wide enough for the button label in German at Dynamic Type, narrow enough to stay a card. */
const CARD_MAX_WIDTH = 340;
/** Over the board art and its overlays; the drawer's sub-sheets present above it. */
const CARD_Z = 20;
const CARD_FADE_MS = 150;

type TrackEndCardProps = {
  model: TrackEndCardModel;
  /** Run the card's action: carry on with the queue. Only called when there is one. */
  onKeepGoing: () => void;
  onDismiss: () => void;
};

function TrackEndCardImpl({ model, onKeepGoing, onDismiss }: TrackEndCardProps) {
  const { t } = useTranslation('session');
  const { variant, systemColors, m3SurfaceContainers, materialElevation } = useTheme();
  const reduceMotion = useReducedMotion();
  const titleRef = useRef<View>(null);
  useAnnounceBodyFocus(titleRef, true);

  // Android hardware back closes the card before it closes the player.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onDismiss();
      return true;
    });
    return () => subscription.remove();
  }, [onDismiss]);

  // The same card surface as the wall-state callout, in each look.
  const isMaterial = selectByVariant(variant, { material: true, liquidGlass: false });
  const cardSurface = isMaterial
    ? [{ backgroundColor: m3SurfaceContainers.high }, materialElevation.level2]
    : [
        {
          backgroundColor: systemColors.elevatedSurface,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: systemColors.separator,
        },
        shadows.md,
      ];

  const title = model.listName
    ? t('playView.track.end.title', { name: model.listName })
    : t('playView.track.end.titleUnnamed');

  return (
    <View accessibilityViewIsModal style={styles.modalRegion} testID="play-drawer-track-end">
      {/* Tapping beside the card keeps the climber where they are. Labelled, so
          assistive tech has a way out that is not the hardware back button. */}
      <PressableSurface
        onPress={onDismiss}
        accessibilityRole="button"
        accessibilityLabel={t('playView.track.end.stay')}
        style={styles.scrim}
      />
      <Animated.View
        entering={reduceMotion ? undefined : FadeIn.duration(CARD_FADE_MS)}
        style={[styles.card, ...cardSurface]}
      >
        <View ref={titleRef} accessible accessibilityRole="header">
          <Text variant="headline" color={systemColors.label} style={styles.centered}>
            {title}
          </Text>
        </View>
        {model.action ? null : (
          <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.centered}>
            {t('playView.track.end.finished')}
          </Text>
        )}
        {/* One centred stack: the primary action, what it opens right under it,
            then Stay here. Both buttons span the card, so the two choices read
            as a pair rather than a pill and a stray line of text. */}
        {model.action ? (
          <View style={styles.primaryGroup}>
            <Button
              title={t('playView.track.end.keepGoing', { upNextCount: model.upNextCount })}
              variant="filled"
              size="medium"
              onPress={onKeepGoing}
              testID="play-drawer-track-end-keep-going"
              style={styles.fullWidth}
            />
            {/* What "Keep going" opens (#6238), on its own line rather than in
                the button: a native button label does not wrap, and a German
                label plus a climb name outgrows the card. */}
            {model.firstUpNextName ? (
              <Text
                variant="footnote"
                color={systemColors.secondaryLabel}
                numberOfLines={2}
                style={styles.centered}
                testID="play-drawer-track-end-first-up-next"
              >
                {t('playView.track.end.firstUpNext', { name: model.firstUpNextName })}
              </Text>
            ) : null}
          </View>
        ) : null}
        {/* Tonal, and on iOS told it sits on glass so it draws the `bordered`
            capsule: that is the same native button family as the filled one
            above, so the two measure one height at every text size without a
            pinned height that would clip a wrapped label. A Liquid Glass
            capsule lands ~7pt off it (see tick-sheet-metrics). The card is an
            opaque surface, so the tinted capsule stays legible; Android and web
            ignore `over` and draw a Material tonal button. */}
        <Button
          title={t('playView.track.end.stay')}
          variant="tonal"
          size="medium"
          over="glass"
          onPress={onDismiss}
          testID="play-drawer-track-end-stay"
          style={styles.fullWidth}
        />
      </Animated.View>
    </View>
  );
}

export const TrackEndCard = memo(TrackEndCardImpl);

const styles = StyleSheet.create({
  modalRegion: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: CARD_Z,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing[4],
  },
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: overlays.scrim,
  },
  card: {
    width: '100%',
    maxWidth: CARD_MAX_WIDTH,
    borderRadius: borderRadius.lg,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[4],
    gap: spacing[3],
    alignItems: 'center',
  },
  centered: {
    textAlign: 'center',
  },
  primaryGroup: {
    alignSelf: 'stretch',
    alignItems: 'center',
    gap: spacing[2],
  },
  fullWidth: {
    alignSelf: 'stretch',
  },
});
