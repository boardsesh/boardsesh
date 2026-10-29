import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { listedMiniPlayerButtons, miniPlayerMoveSteps, type MiniPlayerButtonId } from '../../lib/mini-player-buttons';
import { useMiniPlayerButtonsEditor } from '../../lib/mini-player-buttons-preference';
import type { SectionMoveDirection } from '../../lib/section-layout';
import { hapticSelection } from '../../lib/haptics';
import { useDeviceLayout } from '../../hooks/use-device-layout';
import type { SectionLayoutRowModel } from '../section-layout/SectionLayoutList';

export type MiniPlayerButtonControl = SectionLayoutRowModel<MiniPlayerButtonId>;

/** Shared labels, rows and actions for the MiniPlayer's buttons: View options and Settings › Climb view. */
export function useMiniPlayerButtonControls() {
  const { t } = useTranslation('common');
  const { buttons, isDefault, setVisible, move, restoreDefaults } = useMiniPlayerButtonsEditor();
  // Wall display is for a tablet mounted at the board; a phone's list leaves it out.
  const { isTablet } = useDeviceLayout();

  const title = t('mobile.settings.miniPlayer.title');
  const description = t('mobile.settings.miniPlayer.description');
  const groupTitle = t('mobile.settings.playerButtons.title');
  const fixedNote = t('mobile.settings.miniPlayer.fixedNote');
  const footer = t('mobile.settings.miniPlayer.footer');
  const footerWide = t('mobile.settings.miniPlayer.footerWide');
  const settingsFooter = t('mobile.settings.playerButtons.settingsFooter');
  const restoreDefaultsLabel = t('mobile.settings.climbDrawer.restoreDefaults');
  const nextLabel = t('mobile.settings.miniPlayer.buttons.next');
  const previousLabel = t('mobile.settings.miniPlayer.buttons.previous');
  const mirrorLabel = t('mobile.settings.playerButtons.buttons.mirror');
  const favoriteLabel = t('mobile.settings.playerButtons.buttons.favorite');
  const queueLabel = t('mobile.settings.playerButtons.buttons.queue');
  const shareLabel = t('mobile.settings.playerButtons.buttons.share');
  const angleLabel = t('mobile.settings.playerButtons.buttons.angle');
  const wallDisplayLabel = t('mobile.settings.miniPlayer.buttons.wallDisplay');
  const mirrorDescription = t('mobile.settings.playerButtons.mirrorDescription');
  const angleDescription = t('mobile.settings.playerButtons.angleDescription');

  const controls = useMemo<MiniPlayerButtonControl[]>(() => {
    const labels: Record<MiniPlayerButtonId, string> = {
      next: nextLabel,
      previous: previousLabel,
      mirror: mirrorLabel,
      favorite: favoriteLabel,
      wallDisplay: wallDisplayLabel,
      queue: queueLabel,
      share: shareLabel,
      angle: angleLabel,
    };
    // Two buttons only appear on some boards; their rows say which.
    const descriptions: Partial<Record<MiniPlayerButtonId, string>> = {
      mirror: mirrorDescription,
      angle: angleDescription,
    };
    return listedMiniPlayerButtons(buttons.order, isTablet).map((id) => ({
      id,
      label: labels[id],
      description: descriptions[id],
      visible: buttons.visible[id],
      movable: true,
    }));
  }, [
    buttons,
    isTablet,
    nextLabel,
    previousLabel,
    mirrorLabel,
    favoriteLabel,
    queueLabel,
    shareLabel,
    angleLabel,
    wallDisplayLabel,
    mirrorDescription,
    angleDescription,
  ]);

  const onVisibleChange = useCallback(
    (buttonId: MiniPlayerButtonId, visible: boolean) => setVisible(buttonId, visible),
    [setVisible],
  );
  // A phone steps a button over Wall display, which it doesn't list, so every
  // move it offers visibly moves a row.
  const onMove = useCallback(
    (buttonId: MiniPlayerButtonId, direction: SectionMoveDirection) => {
      const steps = miniPlayerMoveSteps(buttons, buttonId, direction, isTablet);
      for (let step = 0; step < steps; step += 1) move(buttonId, direction);
    },
    [move, buttons, isTablet],
  );
  const canRestoreDefaults = !isDefault;
  const handleRestoreDefaults = useCallback(() => {
    if (!canRestoreDefaults) return;
    hapticSelection();
    restoreDefaults();
  }, [canRestoreDefaults, restoreDefaults]);

  return {
    title,
    description,
    groupTitle,
    fixedNote,
    footer,
    footerWide,
    settingsFooter,
    restoreDefaultsLabel,
    buttons,
    controls,
    onVisibleChange,
    onMove,
    canRestoreDefaults,
    restoreDefaults: handleRestoreDefaults,
  };
}
