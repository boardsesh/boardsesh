import { beforeEach, describe, expect, it, vi } from 'vitest';

const updates = vi.hoisted(() => ({
  isEnabled: true,
  isEmbeddedLaunch: false,
  channel: 'production' as string | null,
  updateId: 'running-update' as string | null,
  runtimeVersion: 'runtime-1' as string | null,
  manifest: { extra: { branch: 'production' } } as unknown,
}));
vi.mock('expo-updates', () => ({
  get isEnabled() {
    return updates.isEnabled;
  },
  get isEmbeddedLaunch() {
    return updates.isEmbeddedLaunch;
  },
  get channel() {
    return updates.channel;
  },
  get updateId() {
    return updates.updateId;
  },
  get runtimeVersion() {
    return updates.runtimeVersion;
  },
  get manifest() {
    return updates.manifest;
  },
  useUpdates: () => ({ downloadedUpdate: { updateId: 'pending-update', manifest: { extra: { branch: 'pr-beta' } } } }),
}));

import { readMobileReleaseContext } from '../release-context';

beforeEach(() => {
  Object.assign(updates, {
    isEnabled: true,
    isEmbeddedLaunch: false,
    channel: 'production',
    updateId: 'running-update',
    runtimeVersion: 'runtime-1',
    manifest: { extra: { branch: 'production' } },
  });
});

describe('readMobileReleaseContext', () => {
  it.each(['production', 'pr-beta', 'pr-staging', 'pr-6000'])(
    'records the running %s branch independently of a pending download',
    (branch) => {
      updates.manifest = { extra: { branch } };
      expect(readMobileReleaseContext()).toEqual({
        channel: 'production',
        branch,
        updateId: 'running-update',
        runtimeVersion: 'runtime-1',
        isEmbeddedLaunch: false,
      });
    },
  );

  it('clears bundle identity for a dev-server launch with updates disabled', () => {
    updates.isEnabled = false;
    expect(readMobileReleaseContext()).toEqual({
      channel: null,
      branch: null,
      updateId: null,
      runtimeVersion: null,
      isEmbeddedLaunch: null,
    });
  });

  it('preserves an embedded launch without inventing a running branch', () => {
    updates.isEmbeddedLaunch = true;
    updates.manifest = null;
    updates.updateId = null;
    expect(readMobileReleaseContext()).toEqual({
      channel: 'production',
      branch: null,
      updateId: null,
      runtimeVersion: 'runtime-1',
      isEmbeddedLaunch: true,
    });
  });
});
