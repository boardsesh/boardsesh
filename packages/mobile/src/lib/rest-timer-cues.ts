// What the rest timer does to tell a climber the rest is ending (#5395, #5396):
// a haptic always, and a sound where the binary has one and the climber wants
// it. The scheduler names the moment (a cue); this module decides what that
// moment feels and sounds like, so a new sink never touches the scheduler.
//
// Invariants the scheduler keeps (docs/rest-timer.md):
// - Exactly one terminal cue per deadline: `advance` when it called nextClimb(),
//   `reached` when the rest ran out and the wall did not move, a dead end (the
//   end of the queue or the list) included.
// - Countdown ticks and the single `warning` never both play for one rest.

import { getSetting } from '../settings';
import { hapticLight, hapticMedium, hapticSelection, hapticSuccess } from './haptics';
import { createSoundPlayer, isSoundSupported, type SoundPlayer } from './sounds';

export type RestTimerCue =
  /** Each second of the final countdown. */
  | { kind: 'countdownTick'; secondsLeft: number }
  /** One heads-up before an auto-advance, when per-second cues are off. */
  | { kind: 'warning' }
  /** The rest ran out and the wall did NOT move (auto-advance off, a passenger). */
  | { kind: 'reached' }
  /** The scheduler moved the wall to the next climb. */
  | { kind: 'advance' };

export type RestTimerCueKind = RestTimerCue['kind'];

type RestTimerCueHaptic = 'selection' | 'light' | 'medium' | 'success';
type RestTimerCueSound = Parameters<SoundPlayer['play']>[0];

/** The haptic each cue plays. `warning`, `advance` and `reached` are the timer's original three. */
export const REST_TIMER_CUE_HAPTIC: Readonly<Record<RestTimerCueKind, RestTimerCueHaptic>> = {
  countdownTick: 'selection',
  warning: 'light',
  advance: 'medium',
  reached: 'success',
};

/** The sound each cue plays where there is a sound to play. */
export const REST_TIMER_CUE_SOUND: Readonly<Record<RestTimerCueKind, RestTimerCueSound>> = {
  countdownTick: 'tick',
  warning: 'tick',
  reached: 'final',
  advance: 'final',
};

const HAPTIC_PLAYERS: Readonly<Record<RestTimerCueHaptic, () => void>> = {
  selection: hapticSelection,
  light: hapticLight,
  medium: hapticMedium,
  success: hapticSuccess,
};

// `undefined` = not created yet, or the last one failed; `null` = this binary has
// none. Created on the first cue that wants a sound and kept while it works, so a
// 1 Hz countdown never builds a player per second. A player that throws, while
// being built or while playing, is dropped: the next cue builds a fresh one
// instead of the timer staying silent until the app restarts.
let soundPlayer: SoundPlayer | null | undefined;

function playCueSound(sound: RestTimerCueSound): void {
  try {
    if (soundPlayer === undefined) soundPlayer = createSoundPlayer();
    soundPlayer?.play(sound);
  } catch {
    soundPlayer = undefined;
  }
}

/** Whether this binary can play the cue sounds. The Sound setting row shows only where this is true. */
export function isRestTimerSoundAvailable(): boolean {
  return isSoundSupported();
}

/**
 * Plays one cue. Fire-and-forget and never throws: a cue runs inside the
 * scheduler's timeout, and a failing sink must not stop the wall advancing. The
 * haptic plays whatever the sound does.
 */
export function playRestTimerCue(cue: RestTimerCue): void {
  try {
    HAPTIC_PLAYERS[REST_TIMER_CUE_HAPTIC[cue.kind]]();
  } catch {
    // A haptic is decoration; the advance it accompanies has already happened.
  }

  // The haptic has already played, so a slow or failing player never holds it back.
  try {
    // Availability first: on a binary with no sound this never reads the setting.
    if (!isRestTimerSoundAvailable() || !getSetting('restTimerSound')) return;
    playCueSound(REST_TIMER_CUE_SOUND[cue.kind]);
  } catch {
    // The sink reports its own failures; a beep that did not play is not a
    // reason to break the timer.
  }
}

/**
 * Swaps the sound player. `undefined` puts back the lazy real one, `null` means
 * "no player". Tests only.
 */
export function setRestTimerSoundPlayerForTests(player: SoundPlayer | null | undefined): void {
  soundPlayer = player;
}
