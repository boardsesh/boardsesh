// The persisted list of downloads a person started (issue #4310). Persisted for
// the same reason the download triggers are: a download can be cut off and
// resumed on a later launch, and it should still hold the screen awake then.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockStorage = new Map<string, string>();

vi.mock('react-native-mmkv', () => {
  const createMockInstance = () => ({
    getString: (key: string) => mockStorage.get(key),
    set: (key: string, value: string) => void mockStorage.set(key, value),
    remove: (key: string) => void mockStorage.delete(key),
    clearAll: () => mockStorage.clear(),
  });
  return { createMMKV: vi.fn(() => createMockInstance()) };
});

import { subscribeSettings } from '../hooks';
import { forgetUserStartedDownload, getUserStartedDownloads, rememberUserStartedDownload } from '../offline-boards';

beforeEach(() => {
  mockStorage.clear();
});

describe('user-started downloads', () => {
  it('starts empty', () => {
    expect(getUserStartedDownloads()).toEqual([]);
  });

  it('remembers scopes in the order they were started', () => {
    rememberUserStartedDownload('kilter:1:10');
    rememberUserStartedDownload('tension:9:1');

    expect(getUserStartedDownloads()).toEqual(['kilter:1:10', 'tension:9:1']);
  });

  it('forgets one scope and keeps the rest', () => {
    rememberUserStartedDownload('kilter:1:10');
    rememberUserStartedDownload('tension:9:1');

    forgetUserStartedDownload('kilter:1:10');

    expect(getUserStartedDownloads()).toEqual(['tension:9:1']);
  });

  // Every settings write re-renders every `useSetting` reader, so a repeat tap
  // on a board that is already downloading must not write again.
  it('writes nothing when the list would not change', () => {
    rememberUserStartedDownload('kilter:1:10');
    const onSettingsChange = vi.fn();
    const unsubscribe = subscribeSettings(onSettingsChange);

    rememberUserStartedDownload('kilter:1:10');
    forgetUserStartedDownload('tension:9:1');

    unsubscribe();
    expect(onSettingsChange).not.toHaveBeenCalled();
  });

  it('reads a value of another shape as empty rather than holding the screen on for it', () => {
    mockStorage.set('offlineUserStartedDownloads', JSON.stringify({ 'kilter:1:10': true }));
    expect(getUserStartedDownloads()).toEqual([]);

    mockStorage.set('offlineUserStartedDownloads', JSON.stringify(['kilter:1:10', 7, null]));
    expect(getUserStartedDownloads()).toEqual(['kilter:1:10']);
  });
});
