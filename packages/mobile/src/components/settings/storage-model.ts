import type { CachedImageMeasurement } from '../../lib/sweep-caches';
import type { MoreFormModel, MoreRow, MoreSection } from '../MoreForm.types';

type Translation = (key: string, options?: Record<string, unknown>) => string;

/** One downloaded board scope, already labelled by the screen. */
export type StorageBoardEntry = {
  scopeKey: string;
  /** The layout, e.g. "Kilter Board Original". */
  title: string;
  /** Board + size, e.g. "Kilter · 12 x 14". */
  subtitle: string;
  /** Footprint, e.g. "About 180 MB · 41,000 climbs". */
  caption: string;
  /** Whether this scope is still kept offline, or is leftover data. */
  statusLabel: string;
};

export type StorageModelInput = {
  t: Translation;
  formatSize: (bytes: number) => string;
  /** The offline-downloads kill switch. Off still shows (and clears) what's on the phone. */
  offlineEnabled: boolean;
  totalBytes: number;
  /** Null where the platform can't say. */
  freeBytes: number | null;
  reclaimableBytes: number;
  /** Reserved space is big enough to be worth a manual Compact (see RECLAIMABLE_VISIBLE_BYTES). */
  showReclaimable: boolean;
  /** Null on the browser build, where there is no cache directory to measure. */
  cachedImages: CachedImageMeasurement | null;
  boards: StorageBoardEntry[];
  removingScopeKey: string | null;
  isRemovingAll: boolean;
  isCompacting: boolean;
  isClearingCache: boolean;
  onRemoveBoard: (scopeKey: string) => void;
  onRemoveAll: () => void;
  onCompact: () => void;
  onClearCachedImages: () => void;
};

/**
 * Manage Storage as plain data.
 *
 * The measured total sits in its own section, above every header, so the
 * approximate per-board figures further down are never read as summing into it.
 * Reserved space comes next when there is any: it is the one actionable thing a
 * failed compaction leaves behind, and it must not sit below a long board list.
 *
 * A board row is the removal: tapping it asks first (the screen owns the
 * confirm). While any write is running the board rows stop being tappable, the
 * running one shows a spinner, and the other buttons grey out, so two teardowns
 * can never overlap.
 */
export function buildStorageModel(input: StorageModelInput): MoreFormModel {
  const { t, formatSize, removingScopeKey, isRemovingAll, isCompacting, isClearingCache } = input;
  const isBusy = removingScopeKey !== null || isRemovingAll || isCompacting || isClearingCache;
  const sections: MoreSection[] = [];

  // The flag is a kill switch; someone rolled back still has the gigabytes.
  const usageFooter = input.offlineEnabled
    ? t('mobile.settings.storage.intro')
    : `${t('mobile.settings.storage.intro')}\n\n${t('mobile.settings.storage.offNote')}`;
  const usageRows: MoreRow[] = [
    {
      kind: 'value',
      key: 'total',
      label: t('mobile.settings.storage.totalLabel'),
      value: formatSize(input.totalBytes),
    },
  ];
  if (input.freeBytes !== null) {
    usageRows.push({
      kind: 'value',
      key: 'free',
      label: t('mobile.settings.storage.freeLabel'),
      value: formatSize(input.freeBytes),
    });
  }
  sections.push({ key: 'usage', footer: usageFooter, rows: usageRows });

  if (input.showReclaimable) {
    sections.push({
      key: 'reserved',
      title: t('mobile.settings.storage.reservedHeader'),
      footer: t('mobile.settings.storage.reservedNote', { size: formatSize(input.reclaimableBytes) }),
      rows: [
        {
          kind: 'button',
          key: 'compact',
          label: t('mobile.settings.storage.compact', { size: formatSize(input.reclaimableBytes) }),
          loading: isCompacting,
          disabled: removingScopeKey !== null || isRemovingAll,
          onPress: input.onCompact,
        },
      ],
    });
  }

  // Board art and photos. Absent on the browser build. The Photos row is left
  // out (never shown as 0 B) when expo-image's cache directory isn't one we
  // recognise; the Clear button still clears it.
  const { cachedImages } = input;
  if (cachedImages) {
    const cacheRows: MoreRow[] = [
      {
        kind: 'value',
        key: 'cachedArt',
        label: t('mobile.settings.storage.cachedImagesArtLabel'),
        value: formatSize(cachedImages.artBytes),
      },
    ];
    if (cachedImages.photoBytes !== null) {
      cacheRows.push({
        kind: 'value',
        key: 'cachedPhotos',
        label: t('mobile.settings.storage.cachedImagesPhotosLabel'),
        value: formatSize(cachedImages.photoBytes),
      });
    }
    cacheRows.push({
      kind: 'button',
      key: 'clearCachedImages',
      label: t('mobile.settings.storage.clearCachedImages'),
      role: 'destructive',
      loading: isClearingCache,
      disabled: removingScopeKey !== null || isRemovingAll || isCompacting,
      onPress: input.onClearCachedImages,
    });
    sections.push({
      key: 'cachedImages',
      title: t('mobile.settings.storage.cachedImagesHeader'),
      footer: t('mobile.settings.storage.cachedImagesNote'),
      rows: cacheRows,
    });
  }

  // Reachable with no boards left: a failed compaction is exactly the state
  // where the list is empty but there is still something to do above.
  if (input.boards.length === 0) {
    sections.push({
      key: 'boards',
      title: t('mobile.settings.storage.boardsHeader'),
      footer: t('mobile.settings.storage.emptySubtitle'),
      rows: [],
    });
    return { sections };
  }

  sections.push({
    key: 'boards',
    title: t('mobile.settings.storage.boardsHeader'),
    footer: `${t('mobile.settings.storage.tapToRemove')} ${t('mobile.settings.storage.estimateNote')}`,
    rows: input.boards.map((board): MoreRow => ({
      kind: 'value',
      key: `board:${board.scopeKey}`,
      label: board.title,
      // Four facts, and the footprint and offline status are the two this screen
      // exists to show, so they wrap rather than truncate.
      subtitle: `${board.subtitle}\n${board.caption}\n${board.statusLabel}`,
      busy: removingScopeKey === board.scopeKey,
      onPress: isBusy ? undefined : () => input.onRemoveBoard(board.scopeKey),
      // The label is just the board's name; this says what a tap does.
      accessibilityHint: isBusy ? undefined : t('mobile.settings.storage.removeAria', { name: board.title }),
    })),
  });

  sections.push({
    key: 'removeAll',
    rows: [
      {
        kind: 'button',
        key: 'removeAll',
        label: t('mobile.settings.storage.removeAll'),
        role: 'destructive',
        loading: isRemovingAll,
        disabled: removingScopeKey !== null || isCompacting,
        onPress: input.onRemoveAll,
      },
    ],
  });

  return { sections };
}
