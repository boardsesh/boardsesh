// An OTA bundle reaches binaries older than driving on the Lock Screen (2.7). On
// those the native methods do not exist and every call must be a silent
// no-op: the drive itself must never notice the Lock Screen is missing.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LiveActivityKeepLightingConfig,
  LiveActivityLightingWindowOptions,
  LiveActivityLightingWindowSnapshot,
} from '../../../../modules/live-activity/src/index';

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

const WINDOW: LiveActivityLightingWindowOptions = {
  sessionId: 'session-1',
  mode: 'window',
  endsAtMs: 46_000,
  windowSeconds: 45,
  family: 'general',
};

const CONFIG: LiveActivityKeepLightingConfig = {
  keepLighting: '45',
  // JS sends the general choice in the MoonBoard slot too (`buildKeepLightingConfig`).
  moonboardKeepLighting: '45',
  drivesInSession: true,
  inCrew: false,
  moonboard: false,
  enabled: true,
};

const STORED: LiveActivityLightingWindowSnapshot = { ...WINDOW, source: 'lockScreen', updatedAtMs: 1_000 };

async function loadPlugin() {
  vi.resetModules();
  return import('../live-activity-plugin');
}

beforeEach(() => {
  native.platform = 'ios';
  native.liveActivity = null;
  native.sessionPresence = null;
});

describe('lighting window bridge (driving the wall)', () => {
  it('is a silent no-op on a binary that predates it', async () => {
    const getLightingWindow = vi.fn(() => STORED);
    // An older binary: no support flag, no methods.
    native.liveActivity = { isAvailable: vi.fn(), getLightingWindow };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const plugin = await loadPlugin();
    expect(plugin.sessionPresenceSupportsLightingWindow).toBe(false);
    await expect(plugin.updateLiveActivityLightingWindow(WINDOW)).resolves.toBeUndefined();
    await expect(plugin.updateLiveActivityKeepLightingConfig(CONFIG)).resolves.toBeUndefined();
    expect(plugin.readLiveActivityLightingWindow()).toBeNull();
    expect(getLightingWindow).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('forwards the window, the settings and the read on iOS', async () => {
    const updateLightingWindow = vi.fn(async () => {});
    const updateKeepLightingConfig = vi.fn(async () => {});
    native.liveActivity = {
      supportsLightingWindow: true,
      updateLightingWindow,
      updateKeepLightingConfig,
      getLightingWindow: () => STORED,
    };
    const plugin = await loadPlugin();
    expect(plugin.sessionPresenceMirrorsKeepLighting).toBe(true);
    await plugin.updateLiveActivityLightingWindow(WINDOW);
    await plugin.updateLiveActivityLightingWindow(null);
    await plugin.updateLiveActivityKeepLightingConfig(CONFIG);
    expect(updateLightingWindow).toHaveBeenNthCalledWith(1, WINDOW);
    expect(updateLightingWindow).toHaveBeenNthCalledWith(2, null);
    expect(updateKeepLightingConfig).toHaveBeenCalledWith(CONFIG);
    expect(plugin.readLiveActivityLightingWindow()).toEqual(STORED);
  });

  it('routes the window to the Android module on Android, and mirrors no settings there', async () => {
    native.platform = 'android';
    const iosUpdate = vi.fn(async () => {});
    const iosConfig = vi.fn(async () => {});
    const androidUpdate = vi.fn(async () => {});
    native.liveActivity = {
      supportsLightingWindow: true,
      updateLightingWindow: iosUpdate,
      updateKeepLightingConfig: iosConfig,
    };
    native.sessionPresence = { supportsLightingWindow: true, updateLightingWindow: androidUpdate };
    const plugin = await loadPlugin();
    await plugin.updateLiveActivityLightingWindow(WINDOW);
    expect(androidUpdate).toHaveBeenCalledWith(WINDOW);
    expect(iosUpdate).not.toHaveBeenCalled();
    // A notification press opens its window in JS: nothing native reads the settings.
    expect(plugin.sessionPresenceMirrorsKeepLighting).toBe(false);
    await plugin.updateLiveActivityKeepLightingConfig(CONFIG);
    expect(iosConfig).not.toHaveBeenCalled();
  });

  it('turns a native failure into a warning and a failed read into null', async () => {
    native.liveActivity = {
      supportsLightingWindow: true,
      updateLightingWindow: vi.fn(async () => {
        throw new Error('boom');
      }),
      getLightingWindow: () => {
        throw new Error('boom');
      },
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const plugin = await loadPlugin();
    await expect(plugin.updateLiveActivityLightingWindow(WINDOW)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(plugin.readLiveActivityLightingWindow()).toBeNull();
    warn.mockRestore();
  });
});

// The iOS intent's press stamp: read synchronously by the timed-drive end check.
describe('lock-screen press stamp read', () => {
  const PRESS = { pressId: 'press-1', expiresAtMs: 9_000 };

  it('reads the stamp on iOS', async () => {
    native.liveActivity = { getLockScreenPress: () => PRESS };
    const plugin = await loadPlugin();
    expect(plugin.readLiveActivityLockScreenPress()).toEqual(PRESS);
  });

  it('is null on a binary without it, on a failed read, and on Android', async () => {
    native.liveActivity = { supportsLightingWindow: true };
    let plugin = await loadPlugin();
    expect(plugin.readLiveActivityLockScreenPress()).toBeNull();

    native.liveActivity = {
      getLockScreenPress: () => {
        throw new Error('boom');
      },
    };
    plugin = await loadPlugin();
    expect(plugin.readLiveActivityLockScreenPress()).toBeNull();

    // Android's press reaches JS before anything lights: no stamp to read.
    native.platform = 'android';
    const getLockScreenPress = vi.fn(() => PRESS);
    native.liveActivity = { getLockScreenPress };
    native.sessionPresence = { getLockScreenPress };
    plugin = await loadPlugin();
    expect(plugin.readLiveActivityLockScreenPress()).toBeNull();
    expect(getLockScreenPress).not.toHaveBeenCalled();
  });
});
