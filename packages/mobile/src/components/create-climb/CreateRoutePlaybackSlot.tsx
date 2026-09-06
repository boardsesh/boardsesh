import { memo } from 'react';
import { View, StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { Button } from '../Button';
import { ButtonSurfaceProvider } from '../Button.surface';
import { PlaybackControls } from '../playback/PlaybackControls';
import { useTheme } from '../../providers/theme-provider';
import { glassSize } from '../../theme/layout';
import { spacing, borderRadius } from '../../theme/tokens';

type PlaybackSlotControls = {
  isPlaying: boolean;
  speed: number;
  paceMs: number;
  play: () => void;
  pause: () => void;
  seek: (index: number) => void;
  setSpeed: (speed: number) => void;
};

type CreateRoutePlaybackSlotProps = {
  /** False on a board whose climbs can only ever hold one frame (Woods). */
  supportsMultiFrame: boolean;
  frameCount: number;
  frameIndex: number;
  playback: PlaybackSlotControls;
  /** "On the wall" once the route has been handed to the queue; null while the
   *  creator still drives the wall itself. */
  wallStateLabel: string | null;
  /** Adds a frame. Wired to the controller's GUARDED duplicate. */
  onAddFrame: () => void;
  /** Removes the frame the transport is sitting on. Only reachable on a route. */
  onDeleteFrame: () => void;
};

/**
 * The route slot under the board: one component that is never empty on a
 * multi-frame board.
 *
 * The transport used to mount only at two frames, and the only way to reach two
 * frames was a bare `copy` glyph fourth inside the action bar's horizontal
 * scroller. A fresh create sheet therefore showed no play control at all and no
 * hint that routes existed — the reason #4761 came back QA-declined. So the slot
 * always occupies the same place: an inert strip that names the feature and
 * offers the one action that unlocks it, replaced by the real transport the
 * moment there is something to play.
 *
 * The strip deliberately borrows PlaybackControls' card chrome (same radius,
 * hairline, margins) so the swap reads as the same surface waking up rather than
 * as two unrelated controls trading places.
 */
export const CreateRoutePlaybackSlot = memo(function CreateRoutePlaybackSlot({
  supportsMultiFrame,
  frameCount,
  frameIndex,
  playback,
  wallStateLabel,
  onAddFrame,
  onDeleteFrame,
}: CreateRoutePlaybackSlotProps) {
  const { t } = useTranslation('climbs');
  const { systemColors } = useTheme();

  // A board that lights one static frame has no route to play, and the frames
  // string it would build carries a comma its packet builder rejects outright.
  if (!supportsMultiFrame) return null;

  if (frameCount > 1) {
    // The nested root is load-bearing on Android, not decoration: the speed
    // slider is a GestureDetector, and this sheet's content lives inside a
    // Jetpack Compose ModalBottomSheet that the app's single root
    // GestureHandlerRootView does not cover (#4320). The explicit style matters
    // too — RNGH defaults to flex: 1, and a flex child inside the drawer's
    // measured View would corrupt peekHeight.
    return (
      <>
        <GestureHandlerRootView style={styles.playbackRoot}>
          <PlaybackControls
            frameIndex={frameIndex}
            frameCount={frameCount}
            isPlaying={playback.isPlaying}
            speed={playback.speed}
            paceMs={playback.paceMs}
            wallStateLabel={wallStateLabel}
            onPlay={playback.play}
            onPause={playback.pause}
            onSeek={playback.seek}
            onSpeedChange={playback.setSpeed}
          />
        </GestureHandlerRootView>

        {/* Frame editing lives here and nowhere else. The strip's own pill only
            gets you to two frames; without this row the third frame was back
            behind the action bar's bare `copy` glyph, which is the same
            discoverability hole one frame later (Marco, iOS). Deliberately
            OUTSIDE PlaybackControls — the play drawer mounts that component too
            and has no frames to edit, so it stays prop-identical.

            Delete leads, Add trails: the primary action belongs nearest the
            thumb on a right-aligned row, and the destructive one belongs
            furthest from it. */}
        <View style={styles.frameActions}>
          <ButtonSurfaceProvider surface="content">
            <Button
              title={t('mobile.create.frames.delete')}
              variant="tonal"
              size="small"
              minHeight={glassSize.inline}
              onPress={onDeleteFrame}
            />
            <Button
              title={t('mobile.create.playback.addFrame')}
              variant="filled"
              size="small"
              minHeight={glassSize.inline}
              onPress={onAddFrame}
            />
          </ButtonSurfaceProvider>
        </View>
      </>
    );
  }

  return (
    <View
      style={[styles.emptyStrip, { borderColor: systemColors.separator }]}
      testID="create-route-playback-empty"
      accessibilityLabel={t('mobile.create.playback.emptyA11y')}
    >
      {/* Decorative, and deliberately NOT an accessible node: it is a play glyph
          that does not play. The row is not `accessible` either — collapsing it
          into one node would swallow the Add frame button, the only thing here
          worth reaching. */}
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Icon name="play.circle" size={22} color={systemColors.tertiaryLabel} />
      </View>
      <Text variant="caption1" style={styles.emptyHint} numberOfLines={1}>
        {t('mobile.create.playback.emptyHint')}
      </Text>
      <ButtonSurfaceProvider surface="content">
        <Button
          title={t('mobile.create.playback.addFrame')}
          variant="filled"
          size="small"
          // Compose sizes a small filled button at 40; this one sits in a row
          // whose other affordance is a 44dp-tall icon. Floor it, the same way
          // the action bar's Save pill is floored.
          minHeight={glassSize.inline}
          onPress={onAddFrame}
        />
      </ButtonSurfaceProvider>
    </View>
  );
});

const styles = StyleSheet.create({
  playbackRoot: {
    alignSelf: 'stretch',
  },
  // A 44dp row plus its 8dp margin — the 52dp CreateDrawer takes out of the
  // board budget on top of the transport's own 84.
  frameActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: spacing[2],
    marginHorizontal: spacing[4],
    marginTop: spacing[2],
  },
  // Deliberately the same card chrome as PlaybackControls' container, minus its
  // vertical padding: this strip is one 44dp row, not a transport.
  emptyStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    marginHorizontal: spacing[4],
    marginTop: spacing[2],
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
    borderRadius: borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  emptyHint: {
    flex: 1,
  },
});
