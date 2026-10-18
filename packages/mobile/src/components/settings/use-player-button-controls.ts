import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { PlayerButtonId, PlayerButtonsPosition } from '../../lib/player-buttons';
import { isDefaultPlayerButtons, usePlayerButtonsEditor } from '../../lib/player-buttons-preference';
import type { SectionMoveDirection } from '../../lib/section-layout';
import { hapticSelection } from '../../lib/haptics';
import type { SectionLayoutRowModel } from '../section-layout/SectionLayoutList';

export type PlayerButtonControl = SectionLayoutRowModel<PlayerButtonId>;

/** Shared labels, rows and actions for the player's buttons: View options and Settings › Climb view. */
export function usePlayerButtonControls() {
  const { t } = useTranslation('common');
  const editor = usePlayerButtonsEditor();
  const { buttons, previousNext, position, setVisible, move, setPreviousNext, setPosition, restoreDefaults } = editor;

  const title = t('mobile.settings.playerButtons.title');
  const description = t('mobile.settings.playerButtons.description');
  const footer = t('mobile.settings.playerButtons.footer');
  const settingsFooter = t('mobile.settings.playerButtons.settingsFooter');
  const positionLabel = t('mobile.settings.playerButtons.position.label');
  const positionFooter = t('mobile.settings.playerButtons.position.footer');
  const belowLabel = t('mobile.settings.playerButtons.position.below');
  const aboveLabel = t('mobile.settings.playerButtons.position.above');
  const previousNextLabel = t('mobile.settings.playerButtons.previousNext');
  const previousNextDescription = t('mobile.settings.playerButtons.previousNextDescription');
  const restoreDefaultsLabel = t('mobile.settings.climbDrawer.restoreDefaults');
  const mirrorLabel = t('mobile.settings.playerButtons.buttons.mirror');
  const favoriteLabel = t('mobile.settings.playerButtons.buttons.favorite');
  const angleLabel = t('mobile.settings.playerButtons.buttons.angle');
  const shareLabel = t('mobile.settings.playerButtons.buttons.share');
  const queueLabel = t('mobile.settings.playerButtons.buttons.queue');
  const mirrorDescription = t('mobile.settings.playerButtons.mirrorDescription');
  const angleDescription = t('mobile.settings.playerButtons.angleDescription');

  const controls = useMemo<PlayerButtonControl[]>(() => {
    const labels: Record<PlayerButtonId, string> = {
      mirror: mirrorLabel,
      favorite: favoriteLabel,
      angle: angleLabel,
      share: shareLabel,
      queue: queueLabel,
    };
    // Two buttons only appear on some boards; their rows say which.
    const descriptions: Partial<Record<PlayerButtonId, string>> = {
      mirror: mirrorDescription,
      angle: angleDescription,
    };
    return buttons.order.map((id) => ({
      id,
      label: labels[id],
      description: descriptions[id],
      visible: buttons.visible[id],
      movable: true,
    }));
  }, [buttons, mirrorLabel, favoriteLabel, angleLabel, shareLabel, queueLabel, mirrorDescription, angleDescription]);

  const positionOptions = useMemo<{ key: PlayerButtonsPosition; label: string }[]>(
    () => [
      { key: 'below', label: belowLabel },
      { key: 'above', label: aboveLabel },
    ],
    [belowLabel, aboveLabel],
  );
  const onPositionChange = useCallback(
    (key: string) => {
      if (key !== 'below' && key !== 'above') return;
      hapticSelection();
      setPosition(key);
    },
    [setPosition],
  );
  const onVisibleChange = useCallback(
    (buttonId: PlayerButtonId, visible: boolean) => setVisible(buttonId, visible),
    [setVisible],
  );
  const onMove = useCallback(
    (buttonId: PlayerButtonId, direction: SectionMoveDirection) => move(buttonId, direction),
    [move],
  );
  const canRestoreDefaults = !isDefaultPlayerButtons({ buttons, previousNext, position });
  const handleRestoreDefaults = useCallback(() => {
    if (!canRestoreDefaults) return;
    hapticSelection();
    restoreDefaults();
  }, [canRestoreDefaults, restoreDefaults]);

  return {
    title,
    description,
    footer,
    settingsFooter,
    positionLabel,
    positionFooter,
    previousNextLabel,
    previousNextDescription,
    restoreDefaultsLabel,
    buttons,
    previousNext,
    position,
    positionOptions,
    controls,
    onPositionChange,
    onPreviousNextChange: setPreviousNext,
    onVisibleChange,
    onMove,
    canRestoreDefaults,
    restoreDefaults: handleRestoreDefaults,
  };
}
