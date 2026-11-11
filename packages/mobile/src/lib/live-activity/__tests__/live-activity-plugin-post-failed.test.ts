// An OTA bundle reaches binaries that do not declare `notificationPostFailed`, so
// the subscription is gated on the binary saying it has the event.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  sessionPresence: null as Record<string, unknown> | null,
}));

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));

vi.mock('../../../../modules/live-activity/src/index', () => ({
  liveActivityNative: null,
  get sessionPresenceNative() {
    return native.sessionPresence;
  },
}));

async function loadPlugin() {
  vi.resetModules();
  return import('../live-activity-plugin');
}

beforeEach(() => {
  native.sessionPresence = null;
});

describe('addNotificationPostFailedListener', () => {
  it('subscribes on a binary that declares the event and unsubscribes on cleanup', async () => {
    const remove = vi.fn();
    const addListener = vi.fn(() => ({ remove }));
    native.sessionPresence = { supportsNotificationPostFailed: true, addListener };
    const { addNotificationPostFailedListener } = await loadPlugin();
    const callback = vi.fn();

    const unsubscribe = addNotificationPostFailedListener(callback);

    expect(addListener).toHaveBeenCalledWith('notificationPostFailed', callback);
    unsubscribe();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('never subscribes on an older binary', async () => {
    const addListener = vi.fn();
    native.sessionPresence = { addListener };
    const { addNotificationPostFailedListener } = await loadPlugin();

    addNotificationPostFailedListener(vi.fn())();

    expect(addListener).not.toHaveBeenCalled();
  });

  it('is a no-op with no native module', async () => {
    const { addNotificationPostFailedListener } = await loadPlugin();

    expect(() => addNotificationPostFailedListener(vi.fn())()).not.toThrow();
  });
});
