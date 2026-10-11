// @vitest-environment jsdom
// The root keep-awake component against the real store (issue #4310): it must
// take and release the `offline-download` lock, and it must not re-render for
// the progress frames in between.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, Profiler } from 'react';
import { cleanup, render } from '@testing-library/react';
import type { SyncProgress } from '@boardsesh/offline-sync';

const mockSettingsStorage = new Map<string, string>();
vi.mock('react-native-mmkv', () => {
  const createMockInstance = () => ({
    getString: (key: string) => mockSettingsStorage.get(key),
    set: (key: string, value: string) => void mockSettingsStorage.set(key, value),
    remove: (key: string) => void mockSettingsStorage.delete(key),
    clearAll: () => mockSettingsStorage.clear(),
  });
  return { createMMKV: vi.fn(() => createMockInstance()) };
});

type AppStateListener = (state: string) => void;
const appState = vi.hoisted(() => ({ listeners: new Set<(state: string) => void>() }));
vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: (_event: string, listener: AppStateListener) => {
      appState.listeners.add(listener);
      return { remove: () => appState.listeners.delete(listener) };
    },
  },
}));

const keepAwake = vi.hoisted(() => ({
  activate: vi.fn().mockResolvedValue(undefined),
  deactivate: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: keepAwake.activate,
  deactivateKeepAwake: keepAwake.deactivate,
}));

import { resetAllSettings, setSetting } from '../../settings';
import {
  __resetDownloadKeepAwakeForTests,
  clearUserStartedDownload,
  markUserStartedDownload,
  noteDownloadProgress,
} from '../../offline/download-keep-awake-store';
import { OfflineDownloadKeepAwake } from '../offline-download-keep-awake';

const KILTER = 'kilter:1:10';

const downloadFrame = (fraction: number): SyncProgress => ({
  phase: 'bootstrap',
  currentTable: KILTER,
  documentsProcessed: 0,
  snapshot: { scopeKey: KILTER, stage: 'download', fraction, wireBytes: 110_000_000, wireBytesDone: null },
});

function startKilterDownload(): void {
  setSetting('syncEnabledBoards', [KILTER]);
  markUserStartedDownload(KILTER);
}

beforeEach(() => {
  __resetDownloadKeepAwakeForTests();
  resetAllSettings();
  appState.listeners.clear();
  keepAwake.activate.mockClear();
  keepAwake.deactivate.mockClear();
});

afterEach(() => {
  cleanup();
  __resetDownloadKeepAwakeForTests();
});

describe('OfflineDownloadKeepAwake', () => {
  it('renders nothing and takes no lock while nothing is downloading', () => {
    const { container } = render(<OfflineDownloadKeepAwake />);

    expect(container.innerHTML).toBe('');
    expect(keepAwake.activate).not.toHaveBeenCalled();
  });

  it('takes the offline-download lock when a user-started download makes progress', () => {
    startKilterDownload();
    render(<OfflineDownloadKeepAwake />);

    act(() => {
      noteDownloadProgress(downloadFrame(0.1));
    });

    expect(keepAwake.activate).toHaveBeenCalledTimes(1);
    expect(keepAwake.activate).toHaveBeenCalledWith('offline-download');
  });

  it('releases the lock when the download completes', () => {
    startKilterDownload();
    render(<OfflineDownloadKeepAwake />);
    act(() => {
      noteDownloadProgress(downloadFrame(0.1));
    });
    keepAwake.deactivate.mockClear();

    act(() => {
      clearUserStartedDownload(KILTER);
    });

    expect(keepAwake.deactivate).toHaveBeenCalledWith('offline-download');
  });

  it('releases the lock when the app goes to the background', () => {
    startKilterDownload();
    render(<OfflineDownloadKeepAwake />);
    act(() => {
      noteDownloadProgress(downloadFrame(0.1));
    });
    keepAwake.deactivate.mockClear();

    act(() => {
      for (const listener of appState.listeners) listener('background');
    });

    expect(keepAwake.deactivate).toHaveBeenCalledWith('offline-download');
  });

  it('leaves the lock alone for a board nobody asked for', () => {
    setSetting('syncEnabledBoards', [KILTER]);
    render(<OfflineDownloadKeepAwake />);

    act(() => {
      noteDownloadProgress(downloadFrame(0.1));
    });

    expect(keepAwake.activate).not.toHaveBeenCalled();
  });

  it('re-renders once for a whole download’s worth of progress frames', () => {
    const onRender = vi.fn();
    startKilterDownload();
    render(
      <Profiler id="offline-download-keep-awake" onRender={onRender}>
        <OfflineDownloadKeepAwake />
      </Profiler>,
    );
    const rendersBeforeDownload = onRender.mock.calls.length;

    act(() => {
      for (let percent = 0; percent <= 100; percent += 1) noteDownloadProgress(downloadFrame(percent / 100));
    });

    expect(onRender.mock.calls.length - rendersBeforeDownload).toBe(1);
    expect(keepAwake.activate).toHaveBeenCalledTimes(1);
  });
});
