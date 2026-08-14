import { useEffect, useMemo } from 'react';
import type { SnapshotGradesArtifact, SnapshotManifestEntry, SnapshotSource } from '@boardsesh/offline-sync';
import { isSnapshotBaseUrlConfigured } from '../lib/env';
import {
  useFeatureFlag,
  useOfflineDownloadProgressEnabled,
  useOfflineDownloadsEnabled,
  useSnapshotBootstrapEnabled,
} from '../providers/feature-flags-provider';
import { mobileSnapshotSource, setSnapshotDownloadStrategyFromFlags } from './snapshot-source';

/**
 * The kill-switch wrapper for download progress (issue #4311). Passing an
 * `onProgress` callback makes expo-file-system take a different NATIVE download
 * implementation — an 8 KB streaming copy loop on Android, a delegate-driven
 * URLSession on iOS instead of `URLSession.shared` plus a completion handler. If
 * that path ever proves slower on a 103 MB artifact, flipping
 * `offline-download-progress` off has to restore the original call exactly, not
 * merely hide the UI — so the options object is dropped here, at the source.
 *
 * This is the THROUGHPUT half of the switch only. The engine still emits its
 * three stage frames (manifest / download-at-zero / import) whether or not a
 * downloader reports bytes, so My Boards reads the same flag before it renders
 * any of them — see `snapshotFrame` in `app/boards/manage.tsx`. Both reads have
 * to stay, or the row sits on "Downloading 0 MB of 103 MB" for the whole
 * download with the switch supposedly off.
 *
 * This wrapper drops the download OPTIONS — `onProgress`, and with it `signal`,
 * which is pre-existing and deliberate (the first paragraph: the restored call
 * must be byte-identical) — never a CAPABILITY. It used to omit
 * `releaseArtifact` and `downloadGradesArtifact`
 * too, which silently opted this cohort out of artifact retention (#4310): the
 * engine falls back to `deleteArtifact`, so a download that completed while the
 * phone was in a pocket was deleted at the end of the cycle and re-fetched from
 * byte 0 on the next wake — exactly the failure #4390 exists to remove, aimed at
 * exactly the users who turned the switch off because their downloads are slow.
 */
function withoutDownloadProgress(source: SnapshotSource): SnapshotSource {
  const { downloadGradesArtifact, releaseArtifact } = source;
  return {
    fetchManifest: () => source.fetchManifest(),
    downloadArtifact: (entry: SnapshotManifestEntry) => source.downloadArtifact(entry),
    deleteArtifact: (filePath: string) => source.deleteArtifact(filePath),
    ...(downloadGradesArtifact
      ? { downloadGradesArtifact: (artifact: SnapshotGradesArtifact) => downloadGradesArtifact(artifact) }
      : {}),
    ...(releaseArtifact
      ? { releaseArtifact: (filePath: string, options: { imported: boolean }) => releaseArtifact(filePath, options) }
      : {}),
  };
}

/**
 * The one gate for handing the engine snapshot I/O: `offline-board-downloads`
 * AND the `offline-snapshot-bootstrap-v2` flag nested under it AND a real
 * build-time manifest URL. `undefined` otherwise, which makes `pullSync` skip
 * the bootstrap phase entirely — a freshly-enabled board still downloads, just
 * through the paged crawl. Every caller that starts or triggers a sync must
 * source its `snapshotSource` from here so the gate can never diverge between
 * surfaces.
 *
 * The `offline-board-downloads` term used to be documentation only. It is a
 * real term now, because that gate is also the platform split: the `.web` fork
 * reads it hard-false, and `mobileSnapshotSource` statically imports
 * `expo-file-system`. Until now the only thing keeping snapshot I/O off Expo
 * web was that no web workflow happens to set `EXPO_PUBLIC_SNAPSHOT_BASE_URL`
 * — an accident, not a guard.
 */
export function useSnapshotSource(): SnapshotSource | undefined {
  const offlineDownloadsEnabled = useOfflineDownloadsEnabled();
  const snapshotBootstrapEnabled = useSnapshotBootstrapEnabled();
  const downloadProgressEnabled = useOfflineDownloadProgressEnabled();
  // The transport choice (issue #4394) is pushed into module state rather than
  // folded into the memo below on purpose: the source's object IDENTITY is a
  // dependency of the scheduler effect in offline-sync-bridge.tsx, so rebuilding
  // it when a PostHog flag resolves would restart the sync scheduler
  // mid-download. Neither flag belongs in the memo deps.
  const taskApiFlag = useFeatureFlag('offline-download-task-api');
  const backgroundSessionFlag = useFeatureFlag('offline-download-background-session');
  useEffect(() => {
    setSnapshotDownloadStrategyFromFlags({ taskApiFlag, backgroundSessionFlag });
  }, [taskApiFlag, backgroundSessionFlag]);
  return useMemo(() => {
    if (!offlineDownloadsEnabled || !snapshotBootstrapEnabled || !isSnapshotBaseUrlConfigured()) return undefined;
    return downloadProgressEnabled ? mobileSnapshotSource : withoutDownloadProgress(mobileSnapshotSource);
  }, [offlineDownloadsEnabled, snapshotBootstrapEnabled, downloadProgressEnabled]);
}
