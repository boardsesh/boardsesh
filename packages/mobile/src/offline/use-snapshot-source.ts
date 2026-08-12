import { useMemo } from 'react';
import type { SnapshotManifestEntry, SnapshotSource } from '@boardsesh/offline-sync';
import { isSnapshotBaseUrlConfigured } from '../lib/env';
import { useOfflineDownloadProgressEnabled, useSnapshotBootstrapEnabled } from '../providers/feature-flags-provider';
import { mobileSnapshotSource } from './snapshot-source';

/**
 * The kill-switch wrapper for download progress (issue #4311). Passing an
 * `onProgress` callback makes expo-file-system take a different NATIVE download
 * implementation — an 8 KB streaming copy loop on Android, a delegate-driven
 * URLSession on iOS instead of `URLSession.shared` plus a completion handler. If
 * that path ever proves slower on a 103 MB artifact, flipping
 * `offline-download-progress` off has to restore the original call exactly, not
 * merely hide the UI — so the options object is dropped here, at the source. The
 * engine keeps emitting its stage captions either way; only the byte detail goes.
 */
function withoutDownloadProgress(source: SnapshotSource): SnapshotSource {
  return {
    fetchManifest: () => source.fetchManifest(),
    downloadArtifact: (entry: SnapshotManifestEntry) => source.downloadArtifact(entry),
    deleteArtifact: (filePath: string) => source.deleteArtifact(filePath),
  };
}

/**
 * The one gate for handing the engine snapshot I/O: the
 * `offline-snapshot-bootstrap-v2` flag (nested under `offline-board-downloads`)
 * AND a real build-time manifest URL. `undefined` otherwise, which makes
 * `pullSync` skip the bootstrap phase entirely — a freshly-enabled board still
 * downloads, just through the paged crawl. Every caller that starts or
 * triggers a sync must source its `snapshotSource` from here so the gate can
 * never diverge between surfaces.
 */
export function useSnapshotSource(): SnapshotSource | undefined {
  const snapshotBootstrapEnabled = useSnapshotBootstrapEnabled();
  const downloadProgressEnabled = useOfflineDownloadProgressEnabled();
  return useMemo(() => {
    if (!snapshotBootstrapEnabled || !isSnapshotBaseUrlConfigured()) return undefined;
    return downloadProgressEnabled ? mobileSnapshotSource : withoutDownloadProgress(mobileSnapshotSource);
  }, [snapshotBootstrapEnabled, downloadProgressEnabled]);
}
