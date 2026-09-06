import { memo } from 'react';
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { PlaybackControls } from '../playback/PlaybackControls';

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
 * Frame editing lives inside the transport card (a frame strip, with add pinned
 * to it) rather than in a detached row of pills underneath, and deleting a frame
 * moved to the same overflow menu that turned route mode on. One card, one
 * control set.
 */
export const CreateRoutePlaybackSlot = memo(function CreateRoutePlaybackSlot({
  showRouteTransport,
  frameCount,
  frameIndex,
  playback,
  wallStateLabel,
  onAddFrame,
  onPaceChange,
}: CreateRoutePlaybackSlotProps) {
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
        speed={playback.speed}
        paceMs={playback.paceMs}
        wallStateLabel={wallStateLabel}
        onPlay={playback.play}
        onPause={playback.pause}
        onSeek={playback.seek}
        onSpeedChange={playback.setSpeed}
        // Seconds, not a multiplier: in the creator this control authors the
        // climb's own `frames_pace`, so it shows the unit the setter is choosing.
        // The play drawer mounts the same component without these two props and
        // keeps the ×multiplier, which is a reader's lens over the setter's pace.
        paceUnit="seconds"
        onPaceChange={onPaceChange}
        frameEditing={{ onAddFrame }}
      />
    </GestureHandlerRootView>
  );
});

const styles = StyleSheet.create({
  playbackRoot: {
    alignSelf: 'stretch',
  },
});
