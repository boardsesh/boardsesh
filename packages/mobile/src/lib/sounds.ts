// The rest timer's sound sink (#5395), shaped like ./haptics.
//
// OWNERSHIP: this is a placeholder on `main`. Playing a sound needs `expo-audio`,
// a native module, so the real body ships in a [native-train] PR on
// `release/next` and reaches `main` at the merge-back. Until then ONLY that PR
// edits this file, which is what keeps the hourly train sync from ever
// conflicting here. Everything else talks to it through ./rest-timer-cues.
//
// On `main` there is no sound: a binary without the native module must never
// try to load it, and `playRestTimerCue` falls back to the haptic alone.

/** The two cue sounds: a short tick for the countdown, a final tone at the end. */
export type SoundPlayer = { play(sound: 'tick' | 'final'): void };

/** Whether this binary can play a sound at all. */
export function isSoundSupported(): boolean {
  return false;
}

/** A player for the cue sounds, or null where there is none. */
export function createSoundPlayer(): SoundPlayer | null {
  return null;
}
