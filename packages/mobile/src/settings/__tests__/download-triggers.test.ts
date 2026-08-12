// Download-trigger attribution (issue #4316). The whole reason this is a
// persisted store rather than an in-memory map: a board enabled with no signal
// downloads on a LATER app launch, and that slow tail is exactly the population
// the funnel is for. An in-memory map would report `unknown` for all of it.

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

import { rememberDownloadTrigger, takeDownloadTrigger, forgetDownloadTrigger } from '../offline-boards';

beforeEach(() => {
  mockStorage.clear();
});

describe('download-trigger attribution', () => {
  it('round-trips a trigger and prunes it on read', () => {
    rememberDownloadTrigger('kilter:1:5', 'download-all');

    expect(takeDownloadTrigger('kilter:1:5')).toBe('download-all');
    // Consuming is what keeps the store bounded: one entry lives from the enable
    // until the download actually starts.
    expect(takeDownloadTrigger('kilter:1:5')).toBe('unknown');
  });

  it('keeps scopes independent', () => {
    rememberDownloadTrigger('kilter:1:5', 'toggle');
    rememberDownloadTrigger('tension:2:10', 'adopt-auto');

    expect(takeDownloadTrigger('tension:2:10')).toBe('adopt-auto');
    expect(takeDownloadTrigger('kilter:1:5')).toBe('toggle');
  });

  it('reports unknown for a scope that was never attributed', () => {
    // A board enabled by a build that predates this store. An explicit, expected
    // value — not an accident.
    expect(takeDownloadTrigger('kilter:1:5')).toBe('unknown');
  });

  it('lets the most recent intent win', () => {
    // Toggled off and back on: the second choice was just as deliberate.
    rememberDownloadTrigger('kilter:1:5', 'auto-download-all');
    rememberDownloadTrigger('kilter:1:5', 'toggle');

    expect(takeDownloadTrigger('kilter:1:5')).toBe('toggle');
  });

  it('degrades an unrecognised stored value to unknown rather than emitting it', () => {
    // A value written by a NEWER build, read after a downgrade. PostHog event
    // names are permanent; a stray trigger value would split the funnel.
    rememberDownloadTrigger('kilter:1:5', 'from-the-future' as never);

    expect(takeDownloadTrigger('kilter:1:5')).toBe('unknown');
  });

  it('forgets a pending attribution when the board is removed before it downloaded', () => {
    rememberDownloadTrigger('kilter:1:5', 'toggle');

    forgetDownloadTrigger('kilter:1:5');

    expect(takeDownloadTrigger('kilter:1:5')).toBe('unknown');
  });
});
