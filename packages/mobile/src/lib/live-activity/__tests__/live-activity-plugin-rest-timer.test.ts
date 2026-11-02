// An OTA bundle reaches binaries older than the rest timer (#6513). On those
// the native method does not exist, and the call must be a silent no-op: the
// rest timer itself must never notice the Lock Screen is missing.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveActivityRestTimerOptions } from '../../../../modules/live-activity/src/index';

const native = vi.hoisted(() => ({
  platform: 'ios' as 'ios' | 'android',
  liveActivity: null as Record<string, unknown> | null,
  sessionPresence: null as Record<string, unknown> | null,
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return native.platform;
    },
  },
}));

vi.mock('../../../../modules/live-activity/src/index', () => ({
  get liveActivityNative() {
    return native.liveActivity;
  },
  get sessionPresenceNative() {
    return native.sessionPresence;
  },
}));

const PAYLOAD: LiveActivityRestTimerOptions = {
  sessionId: 'session-1',
  status: 'running',
  startMs: 1_000,
  deadlineMs: 121_000,
  periodSeconds: null,
  targetSeconds: 120,
  frozenSignedSeconds: null,
};

async function loadPlugin() {
  vi.resetModules();
  return import('../live-activity-plugin');
}

beforeEach(() => {
  native.platform = 'ios';
  native.liveActivity = null;
  native.sessionPresence = null;
});

describe('updateLiveActivityRestTimer', () => {
  it('is a silent no-op on an iOS binary that predates the rest timer', async () => {
    native.liveActivity = { isAvailable: vi.fn() };
    // Silent, not a caught failure: an old binary is a normal state, and a
    // warning on every rest change would bury real native errors.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const plugin = await loadPlugin();
    await expect(plugin.updateLiveActivityRestTimer(PAYLOAD)).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    expect(plugin.sessionPresenceSupportsRestTimer).toBe(false);
    warn.mockRestore();
  });

  it('is a no-op with no native module at all', async () => {
    const plugin = await loadPlugin();
    await expect(plugin.updateLiveActivityRestTimer(null)).resolves.toBeUndefined();
    expect(plugin.sessionPresenceSupportsRestTimer).toBe(false);
  });

  it('routes to the iOS Live Activity, and swallows a native failure', async () => {
    const updateRestTimer = vi.fn(async () => {
      throw new Error('ActivityKit said no');
    });
    native.liveActivity = { supportsRestTimer: true, updateRestTimer };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const plugin = await loadPlugin();

    await expect(plugin.updateLiveActivityRestTimer(PAYLOAD)).resolves.toBeUndefined();
    expect(updateRestTimer).toHaveBeenCalledWith(PAYLOAD);
    expect(plugin.sessionPresenceSupportsRestTimer).toBe(true);
    warn.mockRestore();
  });

  it('routes to the Android session notification, never the iOS module', async () => {
    native.platform = 'android';
    const iosUpdate = vi.fn(async () => {});
    const androidUpdate = vi.fn(async () => {});
    native.liveActivity = { supportsRestTimer: true, updateRestTimer: iosUpdate };
    native.sessionPresence = { supportsRestTimer: true, updateRestTimer: androidUpdate };
    const plugin = await loadPlugin();

    await plugin.updateLiveActivityRestTimer(null);
    expect(androidUpdate).toHaveBeenCalledWith(null);
    expect(iosUpdate).not.toHaveBeenCalled();
  });
});
