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
// which is what a rest timer is for. On iOS the players keep the session active
// between beeps, so a countdown dips the music once rather than once a second,
// and SOUND_SESSION_IDLE_MS after the last beep `setIsAudioActiveAsync(false)`
// hands it back. Android's expo-audio ignores `keepAudioSessionActive` and gives
// up audio focus as each beep ends, so there the music dips once per tick.
// Leaving the foreground hands the session back at once, and coming back hands
// it back once more (see the AppState listener).
//
// Foreground only. The binary has no `audio` background mode, but that alone
// does not keep a beep from playing: iOS keeps running the JavaScript timers that
// fire the cues for a while after the app leaves the foreground, and expo-audio's
// `play()` activates the session with no app-state check. So a beep starts only
// while `AppState` is `active`, checked when it is asked for and again just
// before it plays. `inactive` counts as away: a phone call, Control Center, the
// app switcher, the first moment of a lock.

import { AppState, Platform, type AppStateStatus, type NativeEventSubscription } from 'react-native';
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
 * 450 ms final tone, and longer than the 1 s between countdown ticks, so on iOS
 * a countdown holds the dip from its first tick to its final tone.
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
// The live player's app-state listener. ./rest-timer-cues builds a fresh player
// after a throw, so each build replaces the previous player's listener instead
// of adding one more for the rest of the app run.
let appStateSubscription: NativeEventSubscription | null = null;

function listenToAppState(listener: (nextState: AppStateStatus) => void): void {
  appStateSubscription?.remove();
  appStateSubscription = AppState.addEventListener('change', listener);
}

type CuePlayers = Readonly<Record<CueSound, ExpoAudioModule.AudioPlayer>>;

// The live player's two native players. Each holds a loaded file natively until
// it is removed, so a rebuild removes the dropped player's pair first.
let currentCuePlayers: CuePlayers | null = null;

function removeCurrentCuePlayers(): void {
  if (currentCuePlayers === null) return;
  const { tick, final } = currentCuePlayers;
  currentCuePlayers = null;
  for (const player of [tick, final]) {
    try {
      player.remove();
    } catch {
      // Nothing else can be done with it, and the new pair does not depend on it.
    }
  }
}

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

/**
 * A player for the cue sounds, or null on a binary that has none. Throws when
 * this binary has sound but the player could not be built: null would be kept
 * as "no sound" for the app run, and a throw lets ./rest-timer-cues build a
 * fresh one on the next cue.
 */
export function createSoundPlayer(): SoundPlayer | null {
  if (!isSoundSupported()) return null;
  try {
    return createCueSoundPlayer(bindings.loadExpoAudio());
  } catch (error) {
    reportSoundFailure('create', error);
    throw error;
  }
}

/**
 * Swaps the native bindings, forgets the capability answer, and drops the last
 * player's app-state listener and native players. `undefined` puts back the
 * real bindings. Tests only.
 */
export function setSoundNativeBindingsForTests(next: SoundNativeBindings | undefined): void {
  bindings = next ?? NATIVE_BINDINGS;
  soundSupported = undefined;
  reportedFailureSteps.clear();
  appStateSubscription?.remove();
  appStateSubscription = null;
  removeCurrentCuePlayers();
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

/** Whether a beep may start now; see "Foreground only" in the header. */
function isInForeground(): boolean {
  return AppState.currentState === 'active';
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

/**
 * Both load now, on the first cue that wants a sound, so the second beep and
 * every one after it starts from a loaded file. If the second cannot be built
 * the first is removed, since the caller builds a fresh pair on its next cue.
 */
function loadCuePlayers(audio: ExpoAudio): CuePlayers {
  const tickPlayer = audio.createAudioPlayer(SOUND_SOURCES.tick, { keepAudioSessionActive: true });
  try {
    return {
      tick: tickPlayer,
      final: audio.createAudioPlayer(SOUND_SOURCES.final, { keepAudioSessionActive: true }),
    };
  } catch (error) {
    try {
      tickPlayer.remove();
    } catch {
      // The build failure is the one worth reporting.
    }
    throw error;
  }
}

function createCueSoundPlayer(audio: ExpoAudio): SoundPlayer {
  // ./rest-timer-cues asks for a new player only after dropping the last one.
  removeCurrentCuePlayers();
  const players = loadCuePlayers(audio);
  currentCuePlayers = players;

  let audioModeSet = false;
  // Whether this sink may be holding the audio session (iOS) or audio focus (Android).
  let holdsSession = false;
  // A release turns audio off, and Android then refuses every play until it is
  // turned back on. iOS reactivates on play, so turning it on there is a no-op.
  let releasedSinceLastPlay = false;
  // Bumped by every play request, so a release armed before it knows to stand down.
  let playRequestCount = 0;
  // Set by a hand-back while the app is not in the foreground. expo-audio can
  // turn the session back on behind this sink's back: iOS resumes a player it
  // paused on the way out, and reactivates the session when a phone call ends.
  // Coming back to the foreground then hands it back once more.
  let handedBackWhileAway = false;
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

  async function releaseSession(leavingForeground = false): Promise<void> {
    if (!holdsSession) return;
    holdsSession = false;
    releasedSinceLastPlay = true;
    // The background hand-back is marked even if the app is already back by
    // the time it runs. An idle one counts when it lands while the app is
    // inactive, as it is through a phone call.
    if (leavingForeground || AppState.currentState !== 'active') handedBackWhileAway = true;
    await withDeadline(audio.setIsAudioActiveAsync(false));
  }

  function handBackAgainAfterReturn(): void {
    const requestNumber = playRequestCount;
    enqueue('release', async () => {
      if (!handedBackWhileAway) return;
      handedBackWhileAway = false;
      // A beep asked for since the return arms its own hand-back.
      if (requestNumber !== playRequestCount) return;
      // If nothing turned the session back on, this costs one native call
      // that turns off audio already off. In expo-audio 57.0.5 that is not
      // expected to fail (Android returns early with no focus held; iOS pauses
      // every player before deactivating), and a failure is reported once per run.
      holdsSession = true;
      armIdleRelease(requestNumber);
    });
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

  // Only the newest player listens: one that was replaced is no longer asked to
  // play, and its own idle timer still hands back any session it holds.
  listenToAppState((nextState) => {
    if (nextState === 'background') {
      cancelIdleRelease();
      // Queued, not checked here: a beep already queued holds the session by the time this runs.
      enqueue('release', () => releaseSession(true));
    } else if (nextState === 'active') {
      handBackAgainAfterReturn();
    }
  });

  return {
    play(sound) {
      // Away from the foreground the cue is the haptic alone, and whatever the
      // session is doing (held, or being handed back) carries on untouched.
      if (!isInForeground()) return;
      playRequestCount += 1;
      const requestNumber = playRequestCount;
      cancelIdleRelease();
      enqueue('play', async () => {
        try {
          // The app can leave the foreground while this beep waits its turn.
          if (!isInForeground()) return;
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
          // Or while it rewinds. A session it turned on is handed back as usual.
          if (!isInForeground()) return;
          player.play();
        } finally {
          if (holdsSession) armIdleRelease(requestNumber);
        }
      });
    },
  };
}
