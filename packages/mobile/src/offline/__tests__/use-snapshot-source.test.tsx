// @vitest-environment jsdom
//
// The gate that hands the engine snapshot I/O, and the `offline-download-progress`
// kill switch's wrapper. The wrapper is the interesting half: it only ever meant
// to drop the `onProgress` OPTION, and dropping a capability along with it
// silently opted this cohort out of artifact retention (issue #4390).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import type { SnapshotSource } from '@boardsesh/offline-sync';

const flags = vi.hoisted(() => ({
  offlineDownloadsEnabled: true,
  snapshotBootstrapEnabled: true,
  downloadProgressEnabled: true,
  raw: {} as Record<string, boolean | undefined>,
}));

const sourceSpies = vi.hoisted(() => ({
  fetchManifest: vi.fn(async () => null),
  downloadArtifact: vi.fn(async () => null),
  downloadGradesArtifact: vi.fn(async () => null),
  deleteArtifact: vi.fn(async () => {}),
  releaseArtifact: vi.fn(async () => {}),
}));
const setSnapshotDownloadStrategyFromFlags = vi.hoisted(() => vi.fn());

vi.mock('../../lib/env', () => ({ isSnapshotBaseUrlConfigured: () => true }));
vi.mock('../../providers/feature-flags-provider', () => ({
  useOfflineDownloadsEnabled: () => flags.offlineDownloadsEnabled,
  useSnapshotBootstrapEnabled: () => flags.snapshotBootstrapEnabled,
  useOfflineDownloadProgressEnabled: () => flags.downloadProgressEnabled,
  useFeatureFlag: (key: string) => flags.raw[key],
}));
vi.mock('../snapshot-source', () => ({
  mobileSnapshotSource: sourceSpies,
  setSnapshotDownloadStrategyFromFlags: (value: unknown) => setSnapshotDownloadStrategyFromFlags(value),
}));

import { useSnapshotSource } from '../use-snapshot-source';

function renderSource(): SnapshotSource | undefined {
  return renderHook(() => useSnapshotSource()).result.current;
}

beforeEach(() => {
  vi.clearAllMocks();
  flags.offlineDownloadsEnabled = true;
  flags.snapshotBootstrapEnabled = true;
  flags.downloadProgressEnabled = true;
  flags.raw = {};
});

afterEach(() => {
  cleanup();
});

describe('useSnapshotSource', () => {
  it('hands out the full source when every gate is on', () => {
    expect(renderSource()).toBe(sourceSpies);
  });

  it('withholds snapshot I/O when the snapshot-bootstrap flag is off', () => {
    flags.snapshotBootstrapEnabled = false;
    expect(renderSource()).toBeUndefined();
  });

  it('withholds snapshot I/O when the offline kill switch is off', () => {
    flags.offlineDownloadsEnabled = false;
    expect(renderSource()).toBeUndefined();
  });

  it('pushes the transport flags into module state WITHOUT rebuilding the source', () => {
    // The source's identity is a dependency of the scheduler effect, so a
    // transport flag resolving must not churn it (issue #4394).
    flags.raw = { 'offline-download-task-api': true, 'offline-download-background-session': false };

    expect(renderSource()).toBe(sourceSpies);
    expect(setSnapshotDownloadStrategyFromFlags).toHaveBeenCalledWith({
      taskApiFlag: true,
      backgroundSessionFlag: false,
    });
  });

  describe('with download progress off', () => {
    beforeEach(() => {
      flags.downloadProgressEnabled = false;
    });

    it('drops the onProgress option from downloadArtifact', async () => {
      const source = renderSource();
      await source?.downloadArtifact({ url: 'https://example.test/a.db' } as never, {
        onProgress: () => {},
        signal: new AbortController().signal,
      });

      expect(sourceSpies.downloadArtifact).toHaveBeenCalledTimes(1);
      expect(sourceSpies.downloadArtifact).toHaveBeenCalledWith({ url: 'https://example.test/a.db' });
    });

    it('still forwards releaseArtifact, so a background-completed artifact is RETAINED', async () => {
      // Without this the engine falls back to deleteArtifact and throws away the
      // ~100 MB a pocketed phone just finished downloading (issues #4310/#4390),
      // aimed squarely at the users who turned this switch off because their
      // downloads are slow.
      const source = renderSource();
      expect(source?.releaseArtifact).toBeTypeOf('function');

      await source?.releaseArtifact?.('/cache/kilter-1.db', { imported: false });

      expect(sourceSpies.releaseArtifact).toHaveBeenCalledWith('/cache/kilter-1.db', { imported: false });
    });

    it('still forwards downloadGradesArtifact', async () => {
      const source = renderSource();
      expect(source?.downloadGradesArtifact).toBeTypeOf('function');

      await source?.downloadGradesArtifact?.({ key: 'grades-1' } as never);

      expect(sourceSpies.downloadGradesArtifact).toHaveBeenCalledWith({ key: 'grades-1' });
    });
  });
});
