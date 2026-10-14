import type { MoreFormModel, MoreRow, MoreSection, MoreToggleRow } from '../../MoreForm.types';
import type { SettingsTranslate } from '../root/settings-pages';

export type OfflineModelInput = {
  t: SettingsTranslate;
  /**
   * The offline-downloads switch for this build. Off hides the offline section;
   * the Storage row has its own rule (`showStorage`).
   */
  offlineEnabled: boolean;
  /** The "Offline mode" switch, or `null` where it can do nothing (Expo web). */
  offlineModeRow: MoreToggleRow | null;
  autoOfflineBoards: boolean;
  onAutoOfflineBoardsChange: (enabled: boolean) => void;
  /** Writes still in the outbox. */
  pendingCount: number;
  /** Nothing is going out right now: no signal, server unreachable, or Offline mode. */
  effectiveOffline: boolean;
  showStorage: boolean;
  onOpenStorage: () => void;
};

/**
 * "Offline & storage": the switch that stops every request, keeping boards on
 * the phone, and what those downloads take up.
 *
 * Each half has its own rule, and the page shows whichever apply. Opened when
 * neither does (a deep link, or the flag flipped while it was open) it is
 * simply empty rather than broken.
 */
export function buildOfflineModel(input: OfflineModelInput): MoreFormModel {
  const { t } = input;
  const sections: MoreSection[] = [];

  if (input.offlineEnabled) {
    const rows: MoreRow[] = [];
    // First, because it decides whether anything below it can reach the network
    // at all.
    //
    // It sits inside the `offlineEnabled` gate with the rest of the section.
    // That gate is a constant today, but if it ever went false with the mode
    // ON, the climber is not stranded: the connectivity banner is up the whole
    // time offline mode is on, and its "Go online" turns it back off.
    if (input.offlineModeRow) rows.push(input.offlineModeRow);
    rows.push({
      kind: 'toggle',
      key: 'autoOfflineBoards',
      label: t('mobile.settings.offline.autoDownload'),
      subtitle: t('mobile.settings.offline.autoDownloadDescription'),
      value: input.autoOfflineBoards,
      onValueChange: input.onAutoOfflineBoardsChange,
    });
    sections.push({
      // No section title: it would repeat the page's own.
      key: 'offline',
      // The two things a climber who just logged a send with no signal wants to
      // know: that it is not lost, and that it goes out by itself. Online with
      // work still queued, the same line becomes a live "sending it now".
      footer:
        input.pendingCount === 0
          ? undefined
          : input.effectiveOffline
            ? t('mobile.settings.offline.pendingFooter', { count: input.pendingCount })
            : t('mobile.settings.offline.syncingFooter', { count: input.pendingCount }),
      rows,
    });
  }

  if (input.showStorage) {
    sections.push({
      key: 'storage',
      footer: t('mobile.settings.storage.rowSubtitle'),
      rows: [
        {
          kind: 'nav',
          key: 'storage',
          label: t('mobile.settings.storage.title'),
          icon: 'storage',
          onPress: input.onOpenStorage,
        },
      ],
    });
  }

  return { sections };
}
