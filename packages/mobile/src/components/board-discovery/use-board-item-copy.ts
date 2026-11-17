// What a board card and a board row say about a board beyond its name: the
// "On it" mark, the download state, a spray wall's import step, and the words a
// screen reader needs for what the glyphs show. One place, so the Near you
// cards and the picker's rows can never describe the same board differently.

import { useTranslation } from 'react-i18next';
import { sprayImportCopy } from '../../lib/spray/spray-import-progress';
import type { IconName } from '../icon-map';
import type { DiscoveryBoardItem } from './BoardDiscoveryCardView';
import type { BoardDownloadState } from './board-offline-state';

/** The download glyph at the head of the subtitle line, or none. */
export function offlineGlyphFor(state: BoardDownloadState | undefined): IconName | null {
  if (state === 'downloaded') return 'offline.downloaded';
  if (state === 'downloading' || state === 'finalizing' || state === 'pending') return 'offline.pending';
  return null;
}

/** Distance copy: whole metres under 1 km, one-decimal kilometres above. */
export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

export type BoardItemCopy = {
  onItLabel: string;
  offlineGlyph: IconName | null;
  /** What the download glyph means, for the accessibility label. */
  offlineLabel: string | null;
  /** A spray wall's import step ("Ready to review"), or null. */
  importLabel: string | null;
  distanceLabel: string | null;
  /** "Your board" or "Following", or null when ownership is unknown. */
  ownershipLabel: string | null;
  pinnedLabel: string | null;
};

export function useBoardItemCopy(item: DiscoveryBoardItem): BoardItemCopy {
  const { t } = useTranslation('boards');
  const importCopy = item.sprayImport ? sprayImportCopy(item.sprayImport, item.importStatusStale) : null;
  const offlineState = item.offlineState;
  return {
    onItLabel: t('mobile.discovery.onIt'),
    offlineGlyph: offlineGlyphFor(offlineState),
    offlineLabel:
      offlineState === 'downloaded'
        ? t('mobile.offline.available')
        : offlineState === 'downloading'
          ? t('mobile.offline.bootstrapping')
          : offlineState === 'finalizing'
            ? t('mobile.offline.finalizing')
            : offlineState === 'pending'
              ? t('mobile.offline.pending')
              : null,
    importLabel: importCopy ? t(importCopy.textI18nKey, importCopy.params) : null,
    distanceLabel: item.distanceMeters != null ? formatDistance(item.distanceMeters) : null,
    // No glyph says owned or followed, so the composed label has to: otherwise
    // a screen-reader user cannot tell which board Unfollow removes.
    ownershipLabel:
      item.isViewerOwner === undefined
        ? null
        : item.isViewerOwner
          ? t('mobile.discovery.ownedBadgeAria')
          : t('mobile.discovery.followingBadgeAria'),
    pinnedLabel: item.isPinned === true ? t('mobile.discovery.pinnedBadgeAria') : null,
  };
}

/** The parts of a board's accessibility label, in reading order, joined. */
export function boardItemAccessibilityLabel(item: DiscoveryBoardItem, copy: BoardItemCopy): string {
  return [
    item.title,
    item.isActive ? copy.onItLabel : null,
    copy.distanceLabel,
    item.subtitle,
    copy.ownershipLabel,
    copy.pinnedLabel,
    copy.offlineLabel,
    copy.importLabel,
  ]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(', ');
}
