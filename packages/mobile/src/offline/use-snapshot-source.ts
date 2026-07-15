import type { SnapshotSource } from '@boardsesh/offline-sync';
import { isSnapshotBaseUrlConfigured } from '../lib/env';
import { useSnapshotBootstrapEnabled } from '../providers/feature-flags-provider';
import { mobileSnapshotSource } from './snapshot-source';

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
  return snapshotBootstrapEnabled && isSnapshotBaseUrlConfigured() ? mobileSnapshotSource : undefined;
}
