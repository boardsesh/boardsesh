import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioPlayer } from 'expo-audio';

const platform = vi.hoisted(() => ({ os: 'ios' as string }));
const appState = vi.hoisted(() => ({
  currentState: 'active',
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
  AppState: {
    get currentState() {
      return appState.currentState;
    },
    addEventListener: appState.addEventListener,
  },
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
  players: Record<
    PlayerName,
    { seekTo: ReturnType<typeof vi.fn>; play: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> }
  >;
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
    remove: vi.fn(() => {
      nativeCalls.push(`remove ${name}`);
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

/** Each build of the player gets the next fake, the way a rebuild gets fresh native players. */
function installBindingsPerBuild(...fakes: FakeAudio[]): void {
  const remaining = [...fakes];
  setSoundNativeBindingsForTests({
    hasExpoAudio: () => true,
    loadExpoAudio: () => {
      const next = remaining.shift();
      if (next === undefined) throw new Error(`built more than ${fakes.length} times`);
      return next.audio;
    },
  });
}

/** Lets the sink's queued native calls run. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/** React Native updates `currentState` before it tells the listeners. */
function emitAppState(nextState: string): void {
  appState.currentState = nextState;
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
  appState.currentState = 'active';
  appState.listeners = [];
  appState.addEventListener.mockImplementation((_event: string, listener: (nextState: string) => void) => {
    appState.listeners.push(listener);
    return {
      remove: vi.fn(() => {
        appState.listeners = appState.listeners.filter((registered) => registered !== listener);
      }),
    };
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

  // ./rest-timer-cues keeps a null as "no sound" for the app run, and builds a
  // fresh player on the next cue only after a throw.
  it('throws, and reports once, when expo-audio cannot build a player', () => {
    const fake = makeFakeAudio();
    fake.createAudioPlayer.mockImplementation(() => {
      throw new Error('asset missing');
    });
    installBindings(fake);

    expect(() => createSoundPlayer()).toThrow('asset missing');
    expect(() => createSoundPlayer()).toThrow('asset missing');
    expect(reporting.reportHandledError).toHaveBeenCalledTimes(1);
    expect(reporting.reportHandledError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ level: 'warning', tags: { source: 'rest-timer-sound', step: 'create' } }),
    );
    expect(appState.addEventListener).not.toHaveBeenCalled();
  });

  it('throws when expo-audio itself cannot load', () => {
    const fake = makeFakeAudio();
    const bindings = installBindings(fake);
    bindings.loadExpoAudio.mockImplementation(() => {
      throw new Error('ExpoAudio init failed');
    });

    expect(() => createSoundPlayer()).toThrow('ExpoAudio init failed');
    expect(reporting.reportHandledError).toHaveBeenCalledTimes(1);
  });

  it('removes the tick player when the final one cannot be built, then builds a fresh pair', () => {
    const fake = makeFakeAudio();
    const tickPlayer = fake.players.tick;
    fake.createAudioPlayer
      .mockImplementationOnce(() => tickPlayer as unknown as AudioPlayer)
      .mockImplementationOnce(() => {
        throw new Error('asset missing');
      });
    installBindings(fake);

    expect(() => createSoundPlayer()).toThrow('asset missing');
    expect(tickPlayer.remove).toHaveBeenCalledTimes(1);

    fake.createAudioPlayer.mockImplementation(() => tickPlayer as unknown as AudioPlayer);
    expect(createSoundPlayer()).not.toBeNull();
    expect(fake.createAudioPlayer).toHaveBeenCalledTimes(4);
  });

  // ./rest-timer-cues builds a fresh player after a throw. Each build must
  // replace the app-state listener, not add one for the rest of the app run.
  it("leaves exactly one app-state listener, the newest player's, when the player is built twice", async () => {
    const firstFake = makeFakeAudio();
    const secondFake = makeFakeAudio();
    installBindingsPerBuild(firstFake, secondFake);

    const firstPlayer = createSoundPlayer();
    const secondPlayer = createSoundPlayer();
    if (firstPlayer === null || secondPlayer === null) throw new Error('expected two sound players');

    expect(appState.addEventListener).toHaveBeenCalledTimes(2);
    expect(appState.listeners).toHaveLength(1);

    secondPlayer.play('tick');
    await settle();
    emitAppState('background');
    await settle();

    expect(secondFake.nativeCalls).toEqual(['set audio mode', 'seek tick 0', 'play tick', 'audio off']);
    expect(firstFake.nativeCalls).toEqual(['remove tick', 'remove final']);
  });

  // Each pair holds its loaded file natively until it is removed.
  it('removes the first pair exactly once, before building the second, and leaves the second pair alive', () => {
    const firstFake = makeFakeAudio();
    const secondFake = makeFakeAudio();
    installBindingsPerBuild(firstFake, secondFake);

    createSoundPlayer();
    expect(firstFake.players.tick.remove).not.toHaveBeenCalled();
    createSoundPlayer();

    expect(firstFake.players.tick.remove).toHaveBeenCalledTimes(1);
    expect(firstFake.players.final.remove).toHaveBeenCalledTimes(1);
    const [firstRemoval] = firstFake.players.final.remove.mock.invocationCallOrder;
    const [secondBuild] = secondFake.createAudioPlayer.mock.invocationCallOrder;
    expect(firstRemoval).toBeLessThan(secondBuild);
    expect(secondFake.createAudioPlayer).toHaveBeenCalledTimes(2);
    expect(secondFake.players.tick.remove).not.toHaveBeenCalled();
    expect(secondFake.players.final.remove).not.toHaveBeenCalled();
  });

  it('still removes the other old player and builds a new pair when one removal throws', () => {
    const firstFake = makeFakeAudio();
    const secondFake = makeFakeAudio();
    firstFake.players.tick.remove.mockImplementationOnce(() => {
      throw new Error('already released');
    });
    installBindingsPerBuild(firstFake, secondFake);

    createSoundPlayer();
    expect(() => createSoundPlayer()).not.toThrow();

    expect(firstFake.players.final.remove).toHaveBeenCalledTimes(1);
    expect(secondFake.createAudioPlayer).toHaveBeenCalledTimes(2);
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

  it('never throws, keeps playing later cues, and still hands the session back when a rewind is rejected', async () => {
    const fake = makeFakeAudio();
    fake.players.tick.seekTo.mockRejectedValueOnce(new Error('seek failed'));
    const player = makePlayer(fake);

    expect(() => player.play('tick')).not.toThrow();
    await settle();
    expect(fake.players.tick.play).not.toHaveBeenCalled();
    expect(reporting.reportHandledError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { source: 'rest-timer-sound', step: 'play' } }),
    );

    // The beep had taken the session before its rewind failed, so its idle hand-back runs.
    await vi.advanceTimersByTimeAsync(SOUND_SESSION_IDLE_MS);
    await settle();
    expect(fake.nativeCalls).toEqual(['set audio mode', 'audio off']);

    player.play('tick');
    await settle();
    await vi.advanceTimersByTimeAsync(SOUND_SESSION_IDLE_MS);
    await settle();
    expect(fake.nativeCalls).toEqual([
      'set audio mode',
      'audio off',
      'audio on',
      'seek tick 0',
      'play tick',
      'audio off',
    ]);
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

  it('drops a beep still queued when the app goes to the background, and turns nothing on', async () => {
    const fake = makeFakeAudio();
    const player = makePlayer(fake);

    player.play('tick');
    emitAppState('background');
    await vi.advanceTimersByTimeAsync(SOUND_SESSION_IDLE_MS);

    expect(fake.nativeCalls).toEqual([]);
  });

  it('hands back the session a beep turned on when the app leaves while it rewinds', async () => {
    const fake = makeFakeAudio();
    let finishRewind: () => void = () => {};
    fake.players.final.seekTo.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRewind = resolve;
        }),
    );
    const player = makePlayer(fake);

    player.play('final');
    await settle();
    emitAppState('background');
    finishRewind();
    await settle();
    await vi.advanceTimersByTimeAsync(SOUND_SESSION_IDLE_MS);

    expect(fake.players.final.play).not.toHaveBeenCalled();
    expect(fake.nativeCalls).toEqual(['set audio mode', 'audio off']);
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

// iOS keeps the cue timers running for a while after the app leaves, and
// expo-audio's play() turns the session on there. A beep from a phone the
// climber just locked or switched away from is the bug this guards.
describe('away from the foreground', () => {
  it.each(['background', 'inactive'])('plays nothing and touches no native audio while %s', async (state) => {
    const fake = makeFakeAudio();
    const player = makePlayer(fake);

    emitAppState(state);
    player.play('tick');
    player.play('final');
    await vi.advanceTimersByTimeAsync(SOUND_SESSION_IDLE_MS);

    expect(fake.nativeCalls).toEqual([]);
  });

  it('plays again once the app is back in the foreground', async () => {
    const fake = makeFakeAudio();
    const player = makePlayer(fake);

    emitAppState('background');
    player.play('tick');
    emitAppState('active');
    player.play('final');
    await settle();

    expect(fake.nativeCalls).toEqual(['set audio mode', 'seek final 0', 'play final']);
  });

  // The session the earlier beep holds is handed back on its own schedule.
  it('keeps the idle hand-back of a beep that played before a phone call', async () => {
    const fake = makeFakeAudio();
    const player = makePlayer(fake);

    player.play('tick');
    await settle();
    emitAppState('inactive');
    player.play('tick');
    await vi.advanceTimersByTimeAsync(SOUND_SESSION_IDLE_MS);

    expect(fake.nativeCalls).toEqual(['set audio mode', 'seek tick 0', 'play tick', 'audio off']);
  });
});

// expo-audio turns the session back on behind the sink's back: iOS resumes a
// player it paused on the way out, and reactivates the session after a call.
describe('coming back to the foreground', () => {
  it('hands the session back once more, SOUND_SESSION_IDLE_MS after a background hand-back', async () => {
    const fake = makeFakeAudio();
    const player = makePlayer(fake);

    player.play('final');
    await settle();
    emitAppState('inactive');
    emitAppState('background');
    await settle();
    expect(fake.setIsAudioActiveAsync.mock.calls).toEqual([[false]]);

    emitAppState('active');
    await settle();
    await vi.advanceTimersByTimeAsync(SOUND_SESSION_IDLE_MS - 1);
    expect(fake.setIsAudioActiveAsync).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(fake.setIsAudioActiveAsync.mock.calls).toEqual([[false], [false]]);

    // Once per trip away, not on every later return.
    emitAppState('inactive');
    emitAppState('active');
    await vi.advanceTimersByTimeAsync(SOUND_SESSION_IDLE_MS);
    expect(fake.setIsAudioActiveAsync).toHaveBeenCalledTimes(2);
  });

  it('marks the background hand-back even when the app is back before it runs', async () => {
    const fake = makeFakeAudio();
    const player = makePlayer(fake);

    player.play('final');
    await settle();
    emitAppState('background');
    emitAppState('active');
    await settle();
    await vi.advanceTimersByTimeAsync(SOUND_SESSION_IDLE_MS);

    expect(fake.setIsAudioActiveAsync.mock.calls).toEqual([[false], [false]]);
  });

  // A phone call keeps the app inactive; the idle hand-back lands during it.
  it('hands the session back once more after an idle hand-back that landed while inactive', async () => {
    const fake = makeFakeAudio();
    const player = makePlayer(fake);

    player.play('tick');
    await settle();
    emitAppState('inactive');
    await vi.advanceTimersByTimeAsync(SOUND_SESSION_IDLE_MS);
    expect(fake.setIsAudioActiveAsync.mock.calls).toEqual([[false]]);

    emitAppState('active');
    await vi.advanceTimersByTimeAsync(SOUND_SESSION_IDLE_MS);
    expect(fake.setIsAudioActiveAsync.mock.calls).toEqual([[false], [false]]);
  });

  it('makes no native call on a return when the session was handed back in the foreground', async () => {
    const fake = makeFakeAudio();
    const player = makePlayer(fake);

    player.play('tick');
    await vi.advanceTimersByTimeAsync(SOUND_SESSION_IDLE_MS);
    expect(fake.setIsAudioActiveAsync).toHaveBeenCalledTimes(1);

    emitAppState('inactive');
    emitAppState('active');
    await vi.advanceTimersByTimeAsync(SOUND_SESSION_IDLE_MS);
    expect(fake.setIsAudioActiveAsync).toHaveBeenCalledTimes(1);
  });

  it('leaves the hand-back to a beep asked for right after the return', async () => {
    const fake = makeFakeAudio();
    const player = makePlayer(fake);

    player.play('tick');
    await settle();
    emitAppState('background');
    await settle();
    emitAppState('active');
    player.play('final');
    await settle();
    await vi.advanceTimersByTimeAsync(SOUND_SESSION_IDLE_MS);

    expect(fake.nativeCalls).toEqual([
      'set audio mode',
      'seek tick 0',
      'play tick',
      'audio off',
      'audio on',
      'seek final 0',
      'play final',
      'audio off',
    ]);
  });

  it('turns audio back on before the first beep after the extra hand-back', async () => {
    const fake = makeFakeAudio();
    const player = makePlayer(fake);

    player.play('final');
    await settle();
    emitAppState('background');
    await settle();
    emitAppState('active');
    await vi.advanceTimersByTimeAsync(SOUND_SESSION_IDLE_MS);
    player.play('tick');
    await settle();

    expect(fake.nativeCalls.slice(-4)).toEqual(['audio off', 'audio on', 'seek tick 0', 'play tick']);
  });
});
