import { beforeEach, describe, expect, it, vi } from 'vitest';

const haptics = vi.hoisted(() => ({
  selection: vi.fn(),
  light: vi.fn(),
  medium: vi.fn(),
  success: vi.fn(),
}));

const sound = vi.hoisted(() => ({
  supported: false,
  createSoundPlayer: vi.fn(),
}));

const settings = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));

vi.mock('../haptics', () => ({
  hapticSelection: haptics.selection,
  hapticLight: haptics.light,
  hapticMedium: haptics.medium,
  hapticSuccess: haptics.success,
}));

vi.mock('../sounds', () => ({
  isSoundSupported: () => sound.supported,
  createSoundPlayer: sound.createSoundPlayer,
}));

vi.mock('../../settings', () => ({ getSetting: (key: string) => settings.values[key] }));

import {
  REST_TIMER_CUE_HAPTIC,
  REST_TIMER_CUE_SOUND,
  isRestTimerSoundAvailable,
  playRestTimerCue,
  setRestTimerSoundPlayerForTests,
  type RestTimerCue,
} from '../rest-timer-cues';

const EVERY_CUE: RestTimerCue[] = [
  { kind: 'countdownTick', secondsLeft: 3 },
  { kind: 'warning' },
  { kind: 'reached' },
  { kind: 'advance' },
];

function makePlayer() {
  return { play: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
  sound.supported = false;
  sound.createSoundPlayer.mockReset();
  settings.values = { restTimerSound: true };
  setRestTimerSoundPlayerForTests(undefined);
});

describe('haptics', () => {
  // The timer's original three cues must feel exactly as they did before the
  // seam: a climber who never turns sound on gets the same phone in their hand.
  it('keeps the original mapping: warning light, advance medium, reached success', () => {
    playRestTimerCue({ kind: 'warning' });
    expect(haptics.light).toHaveBeenCalledTimes(1);

    playRestTimerCue({ kind: 'advance' });
    expect(haptics.medium).toHaveBeenCalledTimes(1);

    playRestTimerCue({ kind: 'reached' });
    expect(haptics.success).toHaveBeenCalledTimes(1);

    expect(haptics.selection).not.toHaveBeenCalled();
  });

  it('plays a selection tick for each countdown second', () => {
    playRestTimerCue({ kind: 'countdownTick', secondsLeft: 2 });
    expect(haptics.selection).toHaveBeenCalledTimes(1);
  });

  it('plays exactly one haptic per cue', () => {
    for (const cue of EVERY_CUE) {
      vi.clearAllMocks();
      playRestTimerCue(cue);
      const played = [haptics.selection, haptics.light, haptics.medium, haptics.success].filter(
        (haptic) => haptic.mock.calls.length > 0,
      );
      expect(played).toHaveLength(1);
    }
  });

  it('names a haptic and a sound for every cue kind', () => {
    expect(Object.keys(REST_TIMER_CUE_HAPTIC).sort()).toEqual(['advance', 'countdownTick', 'reached', 'warning']);
    expect(REST_TIMER_CUE_SOUND).toEqual({
      countdownTick: 'tick',
      warning: 'tick',
      reached: 'final',
      advance: 'final',
    });
  });
});

describe('sound', () => {
  it('stays silent on a binary without sound, and never builds a player there', () => {
    expect(isRestTimerSoundAvailable()).toBe(false);
    playRestTimerCue({ kind: 'advance' });

    expect(sound.createSoundPlayer).not.toHaveBeenCalled();
    expect(haptics.medium).toHaveBeenCalledTimes(1);
  });

  it('plays the cue sound where the binary has one and the climber left it on', () => {
    sound.supported = true;
    const player = makePlayer();
    sound.createSoundPlayer.mockReturnValue(player);

    playRestTimerCue({ kind: 'advance' });
    playRestTimerCue({ kind: 'countdownTick', secondsLeft: 1 });

    expect(player.play.mock.calls).toEqual([['final'], ['tick']]);
    // The haptic still plays alongside it.
    expect(haptics.medium).toHaveBeenCalledTimes(1);
  });

  it('stays silent when the climber turned the sound off', () => {
    sound.supported = true;
    settings.values = { restTimerSound: false };
    const player = makePlayer();
    sound.createSoundPlayer.mockReturnValue(player);

    playRestTimerCue({ kind: 'reached' });

    expect(player.play).not.toHaveBeenCalled();
    expect(sound.createSoundPlayer).not.toHaveBeenCalled();
    expect(haptics.success).toHaveBeenCalledTimes(1);
  });

  it('builds the player on the first cue that wants it, and only once', () => {
    sound.supported = true;
    sound.createSoundPlayer.mockReturnValue(makePlayer());
    expect(sound.createSoundPlayer).not.toHaveBeenCalled();

    for (const cue of EVERY_CUE) playRestTimerCue(cue);
    expect(sound.createSoundPlayer).toHaveBeenCalledTimes(1);
  });

  it('does not retry a player that failed to build once', () => {
    sound.supported = true;
    sound.createSoundPlayer.mockImplementation(() => {
      throw new Error('no audio session');
    });

    expect(() => playRestTimerCue({ kind: 'advance' })).not.toThrow();
    expect(() => playRestTimerCue({ kind: 'advance' })).not.toThrow();
    expect(sound.createSoundPlayer).toHaveBeenCalledTimes(1);
    expect(haptics.medium).toHaveBeenCalledTimes(2);
  });

  it('never throws when the player does, and the haptic still plays', () => {
    sound.supported = true;
    setRestTimerSoundPlayerForTests({
      play: () => {
        throw new Error('player gone');
      },
    });

    expect(() => playRestTimerCue({ kind: 'advance' })).not.toThrow();
    expect(haptics.medium).toHaveBeenCalledTimes(1);
  });

  it('never throws when the haptic does, and the sound still plays', () => {
    sound.supported = true;
    const player = makePlayer();
    setRestTimerSoundPlayerForTests(player);
    haptics.success.mockImplementationOnce(() => {
      throw new Error('haptics engine stopped');
    });

    expect(() => playRestTimerCue({ kind: 'reached' })).not.toThrow();
    expect(player.play).toHaveBeenCalledWith('final');
  });
});
