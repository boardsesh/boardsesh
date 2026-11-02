// The one auto-disconnect deadline, read and pushed out by views that never
// see the Bluetooth provider: the keep-lighting window's clock reads it, and the
// player and the wall button tell it the climber is at the wall (2.7).
import { describe, expect, it, vi } from 'vitest';
import {
  noteAutoDisconnectActivity,
  readAutoDisconnectDeadlineMs,
  registerAutoDisconnectActivity,
  registerAutoDisconnectDeadlineReader,
} from '../auto-disconnect-deadline';

describe('auto-disconnect deadline', () => {
  it('reads the registered deadline, and nothing once it unregisters', () => {
    const release = registerAutoDisconnectDeadlineReader(() => 42_000);
    expect(readAutoDisconnectDeadlineMs()).toBe(42_000);
    release();
    expect(readAutoDisconnectDeadlineMs()).toBeNull();
  });

  it('hands activity to the registered handler, and does nothing with no provider', () => {
    expect(() => noteAutoDisconnectActivity()).not.toThrow();
    const handler = vi.fn();
    const release = registerAutoDisconnectActivity(handler);
    noteAutoDisconnectActivity();
    expect(handler).toHaveBeenCalledOnce();
    release();
    noteAutoDisconnectActivity();
    expect(handler).toHaveBeenCalledOnce();
  });

  it('lets an older provider unregister without dropping a newer one', () => {
    const older = vi.fn();
    const newer = vi.fn();
    const releaseOlder = registerAutoDisconnectActivity(older);
    const releaseNewer = registerAutoDisconnectActivity(newer);
    releaseOlder();
    noteAutoDisconnectActivity();
    expect(older).not.toHaveBeenCalled();
    expect(newer).toHaveBeenCalledOnce();
    releaseNewer();
  });
});
