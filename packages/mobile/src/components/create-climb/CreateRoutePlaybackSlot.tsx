import { memo, useCallback } from 'react';
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { DEFAULT_PACE_MS } from '@boardsesh/playback-react';
import { PlaybackControls } from '../playback/PlaybackControls';

/** The pace a release snaps to while authoring: the engine's own default. */
const DEFAULT_PACE_SECONDS = DEFAULT_PACE_MS / 1000;

type PlaybackSlotControls = {
  isPlaying: boolean;
  paceMs: number;
  play: () => void;
  pause: () => void;
  seek: (index: number) => void;
};

type CreateRoutePlaybackSlotProps = {
  /**
   * Whether the creator is authoring a route. False for a boulder and on a board
   * whose climbs can only ever hold one frame (Woods) — in both cases the slot
   * renders nothing and the board keeps the space.
   */
  showRouteTransport: boolean;
  frameCount: number;
  frameIndex: number;
  playback: PlaybackSlotControls;
  /** "On the wall" once the route has been handed to the queue; null while the
   *  creator still drives the wall itself. */
  wallStateLabel: string | null;
  /** Adds a frame. Wired to the controller's GUARDED duplicate. */
  onAddFrame: () => void;
  /** Removes the frame the transport is sitting on. Guarded the same way. */
  onDeleteFrame: () => void;
  /** The setter's authored per-frame pace, in ms. Published as `frames_pace`. */
  onPaceChange: (paceMs: number) => void;
};

/**
 * The route transport under the board.
 *
 * This used to be a permanent strip on every climb, because route-ness was
 * inferred from `frames.length > 1` and there was no way to say "this is a
 * route" before the second frame existed — so the only way to make the feature
 * discoverable was to charge every boulder 52dp for an advert. Route mode is now
 * an explicit state the header's overflow menu owns, which means a boulder can
 * render nothing here and a route can show its transport from frame one.
 *
 * Frame editing lives inside the transport card rather than in a detached row of
 * pills underneath: a chip strip on top, and add/remove as one icon capsule in
 * the transport row beside prev/play/next. One card, one control set — and both
 * frame commands sit where the frames are, rather than one of them hiding in the
 * header's overflow menu a board's height away.
 */
export const CreateRoutePlaybackSlot = memo(function CreateRoutePlaybackSlot({
  showRouteTransport,
  frameCount,
  frameIndex,
  playback,
  wallStateLabel,
  onAddFrame,
  onDeleteFrame,
  onPaceChange,
}: CreateRoutePlaybackSlotProps) {
  // The control speaks seconds; `frames_pace` is stored in ms. Declared above
  // the early return — it is the only hook here and must stay unconditional.
  const handlePaceSecondsChange = useCallback(
    (seconds: number) => onPaceChange(Math.round(seconds * 1000)),
    [onPaceChange],
  );

  if (!showRouteTransport) return null;

  // The nested root is load-bearing on Android, not decoration: the pace slider
  // is a GestureDetector, and this sheet's content lives inside a Jetpack Compose
  // ModalBottomSheet that the app's single root GestureHandlerRootView does not
  // cover (#4320). The explicit style matters too — RNGH defaults to flex: 1, and
  // a flex child inside the drawer's measured View would corrupt peekHeight.
  return (
    <GestureHandlerRootView style={styles.playbackRoot}>
      <PlaybackControls
        frameIndex={frameIndex}
        frameCount={frameCount}
        isPlaying={playback.isPlaying}
        // Here the pace IS the thing being authored, so the control's value is
        // the draft's own `frames_pace`. The play drawer mounts the same
        // component and the same unit, reading its pace back through the
        // playback multiplier.
        paceSeconds={playback.paceMs / 1000}
        // Not the authored pace, which is the value being dragged — a magnet on
        // it would be sticky. The default a never-paced route gets instead.
        magnetSeconds={DEFAULT_PACE_SECONDS}
        wallStateLabel={wallStateLabel}
        onPlay={playback.play}
        onPause={playback.pause}
        onSeek={playback.seek}
        onPaceSecondsChange={handlePaceSecondsChange}
        frameEditing={{ onAddFrame, onDeleteFrame }}
      />
    </GestureHandlerRootView>
  );
});

const styles = StyleSheet.create({
  playbackRoot: {
    alignSelf: 'stretch',
  },
});
