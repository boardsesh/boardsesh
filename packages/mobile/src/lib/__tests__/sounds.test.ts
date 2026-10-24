import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioPlayer } from 'expo-audio';

const platform = vi.hoisted(() => ({ os: 'ios' as string }));
const appState = vi.hoisted(() => ({
  listeners: [] as Array<(nextState: string) => void>,
  addEventListener: vi.fn(),
}));
const reporting = vi.hoisted(() => ({ reportHandledError: vi.fn() }));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return platform.os;
    },
  },
  AppState: { addEventListener: appState.addEventListener },
}));

vi.mock('../error-reporting', () => ({ reportHandledError: reporting.reportHandledError }));

import {
  SOUND_NATIVE_CALL_DEADLINE_MS,
  SOUND_SESSION_IDLE_MS,
  createSoundPlayer,
  isSoundSupported,
  setSoundNativeBindingsForTests,
  type ExpoAudio,
  type SoundNativeBindings,
} from '../sounds';

const PLAYER_NAMES = ['tick', 'final'] as const;
type PlayerName = (typeof PLAYER_NAMES)[number];

type FakeAudio = {
  audio: ExpoAudio;
  /** Every native call, in the order the sink made it. */
  nativeCalls: string[];
  players: Record<PlayerName, { seekTo: ReturnType<typeof vi.fn>; play: ReturnType<typeof vi.fn> }>;
  setAudioModeAsync: ReturnType<typeof vi.fn>;
  setIsAudioActiveAsync: ReturnType<typeof vi.fn>;
  createAudioPlayer: ReturnType<typeof vi.fn>;
};

function makeFakeAudio(): FakeAudio {
  const nativeCalls: string[] = [];
  const makePlayer = (name: PlayerName) => ({
    seekTo: vi.fn(async (seconds: number) => {
      nativeCalls.push(`seek ${name} ${seconds}`);
    }),
    play: vi.fn(() => {
      nativeCalls.push(`play ${name}`);
    }),
  });
  const players = { tick: makePlayer('tick'), final: makePlayer('final') };
  let createdCount = 0;
  // The sink builds the tick player first and the final one second.
  const createAudioPlayer = vi.fn(() => {
    const player = players[PLAYER_NAMES[createdCount]];
    createdCount += 1;
    return player as unknown as AudioPlayer;
  });
  const setAudioModeAsync = vi.fn(async () => {
    nativeCalls.push('set audio mode');
  });
  const setIsAudioActiveAsync = vi.fn(async (isActive: boolean) => {
    nativeCalls.push(isActive ? 'audio on' : 'audio off');
  });
  return {
    audio: {
      createAudioPlayer: createAudioPlayer as unknown as ExpoAudio['createAudioPlayer'],
      setAudioModeAsync: setAudioModeAsync as unknown as ExpoAudio['setAudioModeAsync'],
      setIsAudioActiveAsync: setIsAudioActiveAsync as unknown as ExpoAudio['setIsAudioActiveAsync'],
    },
    nativeCalls,
    players,
    setAudioModeAsync,
    setIsAudioActiveAsync,
    createAudioPlayer,
  };
}

function installBindings(fake: FakeAudio, hasExpoAudio = true) {
  const bindings = {
    hasExpoAudio: vi.fn(() => hasExpoAudio),
    loadExpoAudio: vi.fn(() => fake.audio),
  } satisfies SoundNativeBindings;
  setSoundNativeBindingsForTests(bindings);
  return bindings;
}

/** Lets the sink's queued native calls run. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function emitAppState(nextState: string): void {
  for (const listener of appState.listeners) listener(nextState);
}

function makePlayer(fake: FakeAudio) {
  installBindings(fake);
  const player = createSoundPlayer();
  if (player === null) throw new Error('expected a sound player');
  return player;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  platform.os = 'ios';
  appState.listeners = [];
  appState.addEventListener.mockImplementation((_event: string, listener: (nextState: string) => void) => {
    appState.listeners.push(listener);
    return { remove: vi.fn() };
  });
});

afterEach(() => {
  setSoundNativeBindingsForTests(undefined);
  vi.useRealTimers();
});

describe('isSoundSupported', () => {
  it('is false on web without asking for the native module', () => {
    platform.os = 'web';
    const fake = makeFakeAudio();
    const bindings = installBindings(fake);

    expect(isSoundSupported()).toBe(false);
    expect(createSoundPlayer()).toBeNull();
    expect(bindings.hasExpoAudio).not.toHaveBeenCalled();
    expect(bindings.loadExpoAudio).not.toHaveBeenCalled();
  });

  // Every store binary before this train, and older dev clients, get the same
  // JavaScript by OTA. Loading expo-audio there would throw on import.
  it('is false on a binary without ExpoAudio, and never loads expo-audio there', () => {
    const fake = makeFakeAudio();
    const bindings = installBindings(fake, false);

    expect(isSoundSupported()).toBe(false);
    expect(createSoundPlayer()).toBeNull();
    expect(bindings.loadExpoAudio).not.toHaveBeenCalled();
    expect(appState.addEventListener).not.toHaveBeenCalled();
  });

  it.each(['ios', 'android'])('is true on %s with ExpoAudio, and checks only once', (os) => {
    platform.os = os;
    const bindings = installBindings(makeFakeAudio());

    expect(isSoundSupported()).toBe(true);
    expect(isSoundSupported()).toBe(true);
    expect(bindings.hasExpoAudio).toHaveBeenCalledTimes(1);
  });

  it('is false when the check itself throws', () => {
    setSoundNativeBindingsForTests({
      hasExpoAudio: () => {
        throw new Error('no expo-modules-core');
      },
      loadExpoAudio: () => {
        throw new Error('must not load');
      },
    });

    expect(isSoundSupported()).toBe(false);
    expect(createSoundPlayer()).toBeNull();
  });

  it('touches nothing native until something asks', () => {
    const bindings = installBindings(makeFakeAudio());

    expect(bindings.hasExpoAudio).not.toHaveBeenCalled();
    expect(bindings.loadExpoAudio).not.toHaveBeenCalled();
    expect(appState.addEventListener).not.toHaveBeenCalled();
  });
});

describe('createSoundPlayer', () => {
  it('loads both sounds with the session kept active between beeps, and sets nothing else yet', () => {
    const fake = makeFakeAudio();
    makePlayer(fake);

    expect(fake.createAudioPlayer).toHaveBeenCalledTimes(2);
    for (const [, options] of fake.createAudioPlayer.mock.calls) {
      expect(options).toEqual({ keepAudioSessionActive: true });
    }
    expect(fake.setAudioModeAsync).not.toHaveBeenCalled();
    expect(fake.setIsAudioActiveAsync).not.toHaveBeenCalled();
  });

  it('returns null and reports once when expo-audio cannot build a player', () => {
    const fake = makeFakeAudio();
    fake.createAudioPlayer.mockImplementation(() => {
      throw new Error('asset missing');
    });
    installBindings(fake);

    expect(createSoundPlayer()).toBeNull();
    expect(createSoundPlayer()).toBeNull();
    expect(reporting.reportHandledError).toHaveBeenCalledTimes(1);
    expect(reporting.reportHandledError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ level: 'warning', tags: { source: 'rest-timer-sound', step: 'create' } }),
    );
  });
});

describe('play', () => {
  it('sets the ducking audio mode once, before the first beep', async () => {
    const fake = makeFakeAudio();
    const player = makePlayer(fake);

    player.play('tick');
    await settle();
    player.play('final');
    await settle();

    expect(fake.setAudioModeAsync).toHaveBeenCalledTimes(1);
    expect(fake.setAudioModeAsync).toHaveBeenCalledWith({
      playsInSilentMode: true,
      interruptionMode: 'duckOthers',
      shouldPlayInBackground: false,
      allowsRecording: false,
    });
    expect(fake.nativeCalls).toEqual(['set audio mode', 'seek tick 0', 'play tick', 'seek final 0', 'play final']);
  });

  it('rewinds the same sound before every play', async () => {
    const fake = makeFakeAudio();
    const player = makePlayer(fake);

    player.play('tick');
    player.play('tick');
    await settle();

    expect(fake.nativeCalls).toEqual(['set audio mode', 'seek tick 0', 'play tick', 'seek tick 0', 'play tick']);
  });

  // Until the mode is set the session would stop the climber's music.
  it('skips the beep when the audio mode cannot be set, and tries again on the next cue', async () => {
    const fake = makeFakeAudio();
    fake.setAudioModeAsync.mockRejectedValueOnce(new Error('session busy'));
    const player = makePlayer(fake);

    player.play('tick');
    await settle();
    expect(fake.players.tick.play).not.toHaveBeenCalled();
    expect(reporting.reportHandledError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { source: 'rest-timer-sound', step: 'play' } }),
    );

    player.play('tick');
    await settle();
    expect(fake.setAudioModeAsync).toHaveBeenCalledTimes(2);
    expect(fake.players.tick.play).toHaveBeenCalledTimes(1);
  });

  it('never throws, and keeps playing later cues, when the native player throws', async () => {
    const fake = makeFakeAudio();
    fake.players.tick.play.mockImplementationOnce(() => {
      throw new Error('session interrupted');
    });
    const player = makePlayer(fake);

    expect(() => player.play('tick')).not.toThrow();
    await settle();
    player.play('final');
    await settle();

    expect(fake.players.final.play).toHaveBeenCalledTimes(1);
    expect(reporting.reportHandledError).toHaveBeenCalledTimes(1);
  });

  it('gives up on a native call that never answers, so later cues still play', async () => {
    const fake = makeFakeAudio();
    fake.players.tick.seekTo.mockImplementationOnce(() => new Promise<void>(() => {}));
    const player = makePlayer(fake);

    player.play('tick');
    player.play('final');
    await settle();
    expect(fake.players.final.play).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SOUND_NATIVE_CALL_DEADLINE_MS);

    expect(fake.players.tick.play).not.toHaveBeenCalled();
    expect(fake.players.final.play).toHaveBeenCalledTimes(1);
    expect(reporting.reportHandledError).toHaveBeenCalledTimes(1);
  });
});

describe('handing the session back', () => {
  it('turns audio off SOUND_SESSION_IDLE_MS after the last beep, not before', async () => {
    const fake = makeFakeAudio();
    const player = makePlayer(fake);

    player.play('final');
    await settle();
    await vi.advanceTimersByTimeAsync(SOUND_SESSION_IDLE_MS - 1);
    expect(fake.setIsAudioActiveAsync).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fake.setIsAudioActiveAsync).toHaveBeenCalledTimes(1);
    expect(fake.setIsAudioActiveAsync).toHaveBeenCalledWith(false);
  });

  // A 3-2-1 countdown dips the music once, not once a second.
  it('holds the session through a countdown and hands it back once, after the final tone', async () => {
    const fake = makeFakeAudio();
    const player = makePlayer(fake);

    for (const sound of ['tick', 'tick', 'tick'] as const) {
      player.play(sound);
      await vi.advanceTimersByTimeAsync(1000);
    }
    player.play('final');
    await settle();
    expect(fake.setIsAudioActiveAsync).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SOUND_SESSION_IDLE_MS);
    expect(fake.setIsAudioActiveAsync.mock.calls).toEqual([[false]]);
  });

  // Android refuses every play after setIsAudioActiveAsync(false) until audio is on again.
  it('turns audio back on before the first beep after a hand-back', async () => {
    const fake = makeFakeAudio();
    const player = makePlayer(fake);

    player.play('tick');
    await settle();
    await vi.advanceTimersByTimeAsync(SOUND_SESSION_IDLE_MS);
    player.play('final');
    await settle();

    expect(fake.nativeCalls).toEqual([
      'set audio mode',
      'seek tick 0',
      'play tick',
      'audio off',
      'audio on',
      'seek final 0',
      'play final',
    ]);
  });

  it('does not turn audio on again for a beep that follows another', async () => {
    const fake = makeFakeAudio();
    const player = makePlayer(fake);

    player.play('tick');
    await vi.advanceTimersByTimeAsync(1000);
    player.play('tick');
    await settle();

    expect(fake.setIsAudioActiveAsync).not.toHaveBeenCalled();
  });

  it('hands the session back at once when the app goes to the background', async () => {
    const fake = makeFakeAudio();
    const player = makePlayer(fake);

    player.play('final');
    await settle();
    emitAppState('inactive');
    await settle();
    expect(fake.setIsAudioActiveAsync).not.toHaveBeenCalled();

    emitAppState('background');
    await settle();
    expect(fake.setIsAudioActiveAsync.mock.calls).toEqual([[false]]);

    // The idle timer was cancelled: no second hand-back.
    await vi.advanceTimersByTimeAsync(SOUND_SESSION_IDLE_MS);
    expect(fake.setIsAudioActiveAsync).toHaveBeenCalledTimes(1);
  });

  it('has nothing to hand back when no beep has played', async () => {
    const fake = makeFakeAudio();
    makePlayer(fake);

    emitAppState('background');
    await vi.advanceTimersByTimeAsync(SOUND_SESSION_IDLE_MS);

    expect(fake.setIsAudioActiveAsync).not.toHaveBeenCalled();
  });

  it('never hands back the session for a beep whose audio mode failed', async () => {
    const fake = makeFakeAudio();
    fake.setAudioModeAsync.mockRejectedValueOnce(new Error('session busy'));
    const player = makePlayer(fake);

    player.play('tick');
    await settle();
    await vi.advanceTimersByTimeAsync(SOUND_SESSION_IDLE_MS);

    expect(fake.setIsAudioActiveAsync).not.toHaveBeenCalled();
  });
});
