import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { StorySurface, StoryVariant } from '../../dev/stories/StoryCanvas';
import type { StoryModule } from '../../dev/stories/types';
import { spacing } from '../../theme/tokens';
import type { DriveStartOutcome } from './use-wall-control';
import type { WallGlowInput } from './use-wall-glow';
import { WallControlButton, type WallSwipePreview } from './WallControlButton';
import { resolveWallControl, type WallControlModel, type WallControlState, type WallHolder } from './wall-control';

// Swipe left to drive (#7113): the wall button's hints (‹‹ chevrons, the frost
// peek), the frost wiping in mid-drag, the driving look it lands on, and a
// crewmate's view of it. Pure inputs, like the wall button stories in
// CrewBrowse.stories. `try-it` is live: swipe it left to drive, tap to stop.

const noop = () => {};
const offered = (): DriveStartOutcome => 'unavailable';

/**
 * A climb's lit holds in Kilter's role colours. The board's top lands at the
 * button's trailing edge, so the top holds mix colours for the peek.
 */
const GLOW: WallGlowInput = {
  key: 'drive-mode-story',
  holds: [
    { x: 30, y: 8, color: '#FF00FF' },
    { x: 75, y: 16, color: '#4DF5FD' },
    { x: 50, y: 30, color: '#FFA500' },
    { x: 25, y: 55, color: '#4DF5FD' },
    { x: 70, y: 75, color: '#FFA500' },
    { x: 40, y: 100, color: '#4DF5FD' },
    { x: 65, y: 125, color: '#00DD00' },
    { x: 25, y: 140, color: '#00DD00' },
  ],
  boardWidth: 100,
  boardHeight: 150,
};
/** A climb with no holds to frost: the wipe is the flat live amber. */
const NO_HOLDS: WallGlowInput = { ...GLOW, key: 'drive-mode-story-empty', holds: [] };

/** The model the player would build for one state, with the crewmate named. */
function storyModel(
  state: WallControlState,
  holder: WallHolder,
  { crewName = 'Sam', driveMode = 'off' }: { crewName?: string; driveMode?: 'off' | 'arming' | 'live' } = {},
): WallControlModel {
  const selfHolds = holder === 'self';
  return resolveWallControl({
    commitButton: state === 'put_on_wall' ? 'putOnWall' : null,
    pressAction: state === 'connect' ? 'connect' : state === 'crew' ? 'relay' : selfHolds ? 'disconnect' : 'noop',
    // A crewmate's face and name show only while their link is authoritative.
    holderIsAuthoritative: holder === 'crew',
    localConnected: selfHolds,
    pending: driveMode === 'arming' && state === 'connect',
    displayedLit: state === 'lit',
    offWall: false,
    wallHeldLocally: false,
    holderIsSelfAccount: false,
    selfFace: { name: 'You', avatarUrl: null },
    crewFace: { name: crewName, avatarUrl: null },
    confirmArmed: false,
    commitLabel: 'putOnWall',
    otherClimbLit: false,
    writing: false,
    autoDisconnectWarning: false,
    // In a crew: swipes browse until the climber drives.
    navigationCommits: false,
    driveMode,
  });
}

type Variant = {
  label: string;
  model: WallControlModel;
  preview?: WallSwipePreview;
  glow?: WallGlowInput;
  /** The swipe offered (the flag on). */
  swipe?: boolean;
};

const PUT_ON_WALL = storyModel('put_on_wall', null);
const PUT_ON_SAMS_BOARD = storyModel('put_on_wall', 'crew');
const CONNECT = storyModel('connect', null);
const DISCONNECT = storyModel('lit', 'self');

const HINTS: readonly Variant[] = [
  { label: 'Flag off: no swipe, no hint', model: PUT_ON_WALL, swipe: false },
  { label: 'A, chevrons: Put on board', model: PUT_ON_WALL, preview: {} },
  { label: 'A+B, the peek mid-play: Put on board', model: PUT_ON_WALL, preview: { peek: true } },
  // A swipe takes Sam's board: it asks his phone to let go, then connects (#7113 PR 4).
  { label: "A+B on Sam's board (the swipe takes it)", model: PUT_ON_SAMS_BOARD, preview: { peek: true } },
  { label: 'A+B with no link', model: CONNECT, preview: { peek: true } },
  { label: 'A on Disconnect board (you hold it, not driving)', model: DISCONNECT, preview: {} },
];

const DRAG: readonly Variant[] = [
  { label: 'Dragged 30%: the frost wipes in', model: PUT_ON_WALL, preview: { progress: 0.3 } },
  { label: 'Dragged 70%: let go lights every climb', model: PUT_ON_WALL, preview: { progress: 0.7 } },
  { label: "Dragged 70% on Sam's board: let go takes it", model: PUT_ON_SAMS_BOARD, preview: { progress: 0.7 } },
  {
    label: 'No holds to frost, dragged 70%: the live amber',
    model: PUT_ON_WALL,
    preview: { progress: 0.7 },
    glow: NO_HOLDS,
  },
];

const DRIVING: readonly Variant[] = [
  { label: 'You are driving: every climb lights', model: storyModel('lit', 'self', { driveMode: 'live' }) },
  { label: "Your crewmate's view while Liz drives", model: storyModel('crew', 'crew', { crewName: 'Liz' }) },
];

function VariantStack({ variants, compact = false }: { variants: readonly Variant[]; compact?: boolean }) {
  return (
    <View style={styles.stack}>
      {variants.map(({ label, model, preview, glow = GLOW, swipe = true }) => (
        <StoryVariant key={label} label={label}>
          <StorySurface>
            <View style={compact ? styles.compactRow : styles.buttonRow}>
              <WallControlButton
                model={model}
                compact={compact}
                glow={glow}
                swipePreview={preview}
                onSwipe={swipe ? offered : undefined}
                onPress={noop}
                onLongPress={noop}
              />
            </View>
          </StorySurface>
        </StoryVariant>
      ))}
    </View>
  );
}

/** Arming lasts this long before the story's drive goes live, like a quick connect. */
const STORY_ARMING_MS = 700;

/** A live button: swipe it left to drive, tap the frost to stop. */
function TryIt() {
  const [phase, setPhase] = useState<'off' | 'arming' | 'live'>('off');
  useEffect(() => {
    if (phase !== 'arming') return undefined;
    const timer = setTimeout(() => setPhase('live'), STORY_ARMING_MS);
    return () => clearTimeout(timer);
  }, [phase]);
  const model = useMemo(
    () =>
      phase === 'live'
        ? storyModel('lit', 'self', { driveMode: 'live' })
        : storyModel('put_on_wall', null, { driveMode: phase }),
    [phase],
  );
  const swipe = useCallback((): DriveStartOutcome => {
    setPhase('arming');
    return 'started';
  }, []);
  const press = useCallback(() => setPhase((current) => (current === 'live' ? 'off' : current)), []);
  return (
    <StoryVariant label="Swipe left to drive; tap the frost to stop">
      <StorySurface>
        <View style={styles.buttonRow}>
          <WallControlButton model={model} glow={GLOW} onSwipe={swipe} onPress={press} onLongPress={noop} />
        </View>
      </StorySurface>
    </StoryVariant>
  );
}

const stories: StoryModule = {
  title: 'Play drawer / Swipe to drive',
  stories: {
    hints: {
      name: 'Swipe hints: chevrons (A) and the frost peek (B)',
      render: () => <VariantStack variants={HINTS} />,
    },
    drag: {
      name: 'Mid-swipe: the frost wipes in from the trailing edge',
      render: () => <VariantStack variants={DRAG} />,
    },
    driving: {
      name: 'Driving, and the crewmate watching',
      render: () => <VariantStack variants={DRIVING} />,
    },
    workout: {
      name: "The workout's narrower button: chevrons, peek and a drag",
      render: () => <VariantStack compact variants={[HINTS[1], HINTS[2], DRAG[1]]} />,
    },
    tryIt: {
      name: 'Try it: swipe the button',
      render: () => <TryIt />,
    },
  },
};

export default stories;

const styles = StyleSheet.create({
  stack: {
    gap: spacing[5],
  },
  // The width of a 375pt phone's row, so the stories show the real fit.
  buttonRow: {
    flexDirection: 'row',
    width: 343,
  },
  // Between ⏮ and ⏭ in a workout's top row on a 375pt phone.
  compactRow: {
    flexDirection: 'row',
    width: 239,
  },
});
