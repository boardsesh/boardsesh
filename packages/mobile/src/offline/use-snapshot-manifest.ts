import { useQuery } from '@tanstack/react-query';
import { parseSnapshotManifest, type SnapshotManifest } from '@boardsesh/offline-sync';
import { useSnapshotSource } from './use-snapshot-source';

/**
 * The board-snapshot manifest, for UI that needs to talk about a download before
 * it starts (the My Boards size estimate, issue #3616).
 *
 * The sync engine fetches this manifest too, but strictly inside a sync cycle and
 * only for scopes it is about to bootstrap — there is no cache a screen can read.
 * Rather than a second fetch path, this reuses the same `SnapshotSource.fetchManifest`
 * the engine is handed, so the UI and the engine can never disagree about which
 * manifest is live.
 *
 * `enabled` follows `useSnapshotSource()`: with no build-time base URL, a fresh
 * board downloads via the paged crawl, which has no byte total — so there is
 * nothing to show and no reason to fetch.
 *
 * Callers read this from cache at tap time; the screen mounting is what warms it.
 * Keep it that way — awaiting a manifest fetch inside a press handler would stall
 * the dialog on a slow link.
 */
export function useSnapshotManifest(enabled = true): SnapshotManifest | null {
  const snapshotSource = useSnapshotSource();

  const { data } = useQuery({
    queryKey: ['snapshotManifest'],
    queryFn: async () => {
      // `enabled` below already gates this, but an early return keeps the type
      // honest rather than relying on an optional chain to feed `undefined` into
      // the parser.
      if (!snapshotSource) return null;
      return parseSnapshotManifest(await snapshotSource.fetchManifest());
    },
    enabled: enabled && !!snapshotSource,
    // Mirrors the object's own `Cache-Control: public, max-age=300`. The manifest
    // is rewritten once a night, so anything shorter just re-fetches a 12 KB file
    // to learn nothing.
    staleTime: 5 * 60 * 1000,
  });

  return data ?? null;
}
