// The rest timer's sound sink (#5395), shaped like ./haptics.
//
// OWNERSHIP: this body is the [native-train] PR's, on `release/next`, and it
// reaches `main` at the merge-back. Until then ONLY that PR edits this file,
// which is what keeps the hourly train sync from ever conflicting here.
// Everything else talks to it through ./rest-timer-cues.
//
// OTA safety. A bundle built from this file also reaches binaries that do not
// link expo-audio: every store binary before this train, older dev clients, and
// the Expo web app. Importing `expo-audio` runs `requireNativeModule('ExpoAudio')`,
// which throws there, so nothing native is touched when this module loads. The
// capability check runs on the first cue that wants a sound, and `expo-audio` is
// required only once that check has found its native module. Without it every
// cue is the haptic alone and the Sound setting row stays hidden.
//
// The climber's music. A beep must never stop it. Before the first sound the
// audio mode is set once to `duckOthers`: their music dips under the beep and
// keeps playing. iOS only ducks from the `.playback` category
// (`playsInSilentMode: true`), so the beep also plays through the silent switch,
// which is what a rest timer is for. The players keep the session active between
// beeps, so a countdown dips the music once rather than once a second, and
// SOUND_SESSION_IDLE_MS after the last beep `setIsAudioActiveAsync(false)` hands
// it back. Leaving the foreground hands it back at once. Nothing plays in the
// background: the binary has no `audio` background mode.

import { AppState, Platform } from 'react-native';
import type * as ExpoAudioModule from 'expo-audio';
import type * as ExpoModulesCore from 'expo-modules-core';

import finalSoundAsset from '../../assets/sounds/rest-timer-final.wav';
import tickSoundAsset from '../../assets/sounds/rest-timer-tick.wav';
import { reportHandledError } from './error-reporting';

/** The two cue sounds: a short tick for the countdown, a final tone at the end. */
export type SoundPlayer = { play(sound: 'tick' | 'final'): void };

type CueSound = Parameters<SoundPlayer['play']>[0];

/** The parts of expo-audio this sink uses. */
export type ExpoAudio = Pick<
  typeof ExpoAudioModule,
  'createAudioPlayer' | 'setAudioModeAsync' | 'setIsAudioActiveAsync'
>;

/**
 * Where this sink reaches the native side. Tests swap it: Vitest cannot mock a
 * `require`, and the real module cannot load outside a binary.
 */
export type SoundNativeBindings = {
  /** Whether this binary links the ExpoAudio native module. */
  hasExpoAudio(): boolean;
  /** expo-audio itself. Only once `hasExpoAudio()` is true: its import throws without the module. */
  loadExpoAudio(): ExpoAudio;
};

/** Bundled WAVs (docs/rest-timer.md, "Sound (native train)", lists how they were made). */
const SOUND_SOURCES: Readonly<Record<CueSound, number>> = {
  tick: tickSoundAsset,
  final: finalSoundAsset,
};

/** Duck the climber's music, never stop it; see the header. */
const CUE_AUDIO_MODE: Partial<ExpoAudioModule.AudioMode> = {
  playsInSilentMode: true,
  interruptionMode: 'duckOthers',
  shouldPlayInBackground: false,
  allowsRecording: false,
};

/**
 * How long after the last beep the session is handed back. Longer than the
 * 450 ms final tone, and longer than the 1 s between countdown ticks, so a
 * countdown holds the dip from its first tick to its final tone.
 */
export const SOUND_SESSION_IDLE_MS = 1200;

/** A native call that has not answered by then is given up, so one stuck call never silences every later cue. */
export const SOUND_NATIVE_CALL_DEADLINE_MS = 1000;

const NATIVE_BINDINGS: SoundNativeBindings = {
  hasExpoAudio() {
    // oxlint-disable-next-line import/no-commonjs
    const modulesCore = require('expo-modules-core') as typeof ExpoModulesCore;
    return modulesCore.requireOptionalNativeModule('ExpoAudio') !== null;
  },
  loadExpoAudio() {
    // oxlint-disable-next-line import/no-commonjs
    return require('expo-audio') as ExpoAudio;
  },
};

let bindings: SoundNativeBindings = NATIVE_BINDINGS;
// `undefined` = not checked yet. The answer cannot change within an app run.
let soundSupported: boolean | undefined;

/** Whether this binary can play a sound at all. Never throws. */
export function isSoundSupported(): boolean {
  if (soundSupported === undefined) {
    try {
      soundSupported = (Platform.OS === 'ios' || Platform.OS === 'android') && bindings.hasExpoAudio();
    } catch {
      soundSupported = false;
    }
  }
  return soundSupported;
}

/** A player for the cue sounds, or null where there is none. */
export function createSoundPlayer(): SoundPlayer | null {
  if (!isSoundSupported()) return null;
  try {
    return createCueSoundPlayer(bindings.loadExpoAudio());
  } catch (error) {
    reportSoundFailure('create', error);
    return null;
  }
}

/**
 * Swaps the native bindings and forgets the capability answer. `undefined`
 * puts back the real ones. Tests only.
 */
export function setSoundNativeBindingsForTests(next: SoundNativeBindings | undefined): void {
  bindings = next ?? NATIVE_BINDINGS;
  soundSupported = undefined;
  reportedFailureSteps.clear();
}

type SoundStep = 'create' | 'play' | 'release';

// One report per step per app run: a failure that repeats does so once a
// second through a countdown, and the first one says everything.
const reportedFailureSteps = new Set<SoundStep>();

function reportSoundFailure(step: SoundStep, error: unknown): void {
  if (reportedFailureSteps.has(step)) return;
  reportedFailureSteps.add(step);
  reportHandledError(error, {
    level: 'warning',
    tags: { source: 'rest-timer-sound', step },
    fingerprint: ['rest-timer-sound', step],
  });
}

async function withDeadline<Result>(call: Promise<Result>): Promise<Result> {
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    deadlineTimer = setTimeout(
      () => reject(new Error(`expo-audio did not answer within ${SOUND_NATIVE_CALL_DEADLINE_MS} ms`)),
      SOUND_NATIVE_CALL_DEADLINE_MS,
    );
  });
  try {
    return await Promise.race([call, deadline]);
  } finally {
    clearTimeout(deadlineTimer);
  }
}

function createCueSoundPlayer(audio: ExpoAudio): SoundPlayer {
  // Both load now, on the first cue that wants a sound, so the second beep and
  // every one after it starts from a loaded file.
  const players: Readonly<Record<CueSound, ExpoAudioModule.AudioPlayer>> = {
    tick: audio.createAudioPlayer(SOUND_SOURCES.tick, { keepAudioSessionActive: true }),
    final: audio.createAudioPlayer(SOUND_SOURCES.final, { keepAudioSessionActive: true }),
  };

  let audioModeSet = false;
  // Whether this sink may be holding the audio session (iOS) or audio focus (Android).
  let holdsSession = false;
  // A release turns audio off, and Android then refuses every play until it is
  // turned back on. iOS reactivates on play, so turning it on there is a no-op.
  let releasedSinceLastPlay = false;
  // Bumped by every play request, so a release armed before it knows to stand down.
  let playRequestCount = 0;
  let idleReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  // Native calls run one at a time and in order, so a release never lands
  // between turning audio back on and the play it was for.
  let nativeCalls: Promise<void> = Promise.resolve();

  function enqueue(step: SoundStep, task: () => Promise<void>): void {
    nativeCalls = nativeCalls.then(task).catch((error: unknown) => reportSoundFailure(step, error));
  }

  function cancelIdleRelease(): void {
    if (idleReleaseTimer !== null) {
      clearTimeout(idleReleaseTimer);
      idleReleaseTimer = null;
    }
  }

  async function releaseSession(): Promise<void> {
    if (!holdsSession) return;
    holdsSession = false;
    releasedSinceLastPlay = true;
    await withDeadline(audio.setIsAudioActiveAsync(false));
  }

  function armIdleRelease(requestNumber: number): void {
    // A newer beep is already queued; it arms its own release once it plays.
    if (requestNumber !== playRequestCount) return;
    cancelIdleRelease();
    idleReleaseTimer = setTimeout(() => {
      idleReleaseTimer = null;
      enqueue('release', async () => {
        // A beep was asked for after this timer was armed: keep the session for it.
        if (requestNumber !== playRequestCount) return;
        await releaseSession();
      });
    }, SOUND_SESSION_IDLE_MS);
  }

  AppState.addEventListener('change', (nextState) => {
    if (nextState !== 'background' || !holdsSession) return;
    cancelIdleRelease();
    enqueue('release', releaseSession);
  });

  return {
    play(sound) {
      playRequestCount += 1;
      const requestNumber = playRequestCount;
      cancelIdleRelease();
      enqueue('play', async () => {
        try {
          if (!audioModeSet) {
            // Until the mode is set the session would STOP the climber's
            // music, so a failure here skips the beep; the next cue tries again.
            await withDeadline(audio.setAudioModeAsync(CUE_AUDIO_MODE));
            audioModeSet = true;
          }
          if (releasedSinceLastPlay) {
            await withDeadline(audio.setIsAudioActiveAsync(true));
            releasedSinceLastPlay = false;
          }
          holdsSession = true;
          const player = players[sound];
          // A finished player stays at its end; it has to be rewound before it plays again.
          await withDeadline(player.seekTo(0));
          player.play();
        } finally {
          if (holdsSession) armIdleRelease(requestNumber);
        }
      });
    },
  };
}
