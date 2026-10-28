import type { ReactNode } from 'react';
import type { MiniPlayerButtonId } from '../../../lib/mini-player-buttons';
import type { PlayerButtonId, PlayerButtonsPosition } from '../../../lib/player-buttons';
import type { MoreFormModel, MoreOption, MoreRow, MoreSection } from '../../MoreForm.types';
import type { MiniPlayerButtonControl } from '../use-mini-player-button-controls';
import type { PlayerButtonControl } from '../use-player-button-controls';

export type ClimbViewModelInput = {
  /** The player's buttons, from `usePlayerButtonControls`. */
  buttons: {
    title: string;
    settingsFooter: string;
    positionLabel: string;
    positionFooter: string;
    positionOptions: MoreOption[];
    position: PlayerButtonsPosition;
    onPositionChange: (key: string) => void;
    previousNextLabel: string;
    previousNextDescription: string;
    previousNext: boolean;
    onPreviousNextChange: (enabled: boolean) => void;
    wallBadgeLabel: string;
    wallBadgeDescription: string;
    wallBadge: boolean;
    onWallBadgeChange: (enabled: boolean) => void;
    controls: readonly PlayerButtonControl[];
    onVisibleChange: (buttonId: PlayerButtonId, visible: boolean) => void;
    restoreDefaultsLabel: string;
    canRestoreDefaults: boolean;
    onRestoreDefaults: () => void;
    /** The static drawing of the bar, hosted inside the native form. */
    preview: ReactNode;
    previewHeight: number;
  };
  /** The MiniPlayer's buttons, from `useMiniPlayerButtonControls`. `null` where there is no native bottom accessory to draw them. */
  miniPlayer: null | {
    title: string;
    settingsFooter: string;
    controls: readonly MiniPlayerButtonControl[];
    onVisibleChange: (buttonId: MiniPlayerButtonId, visible: boolean) => void;
    restoreDefaultsLabel: string;
    canRestoreDefaults: boolean;
    onRestoreDefaults: () => void;
  };
  /** "Below the climb", shared with the player's View options sheet. */
  belowTheClimb: MoreSection;
};

/**
 * Settings › Climbs & grades › Climb view: the player's buttons, the MiniPlayer's, then what sits
 * below the climb, top to bottom as the player shows them. Switches only, on
 * the native form; the order changes in the player's ⋯ → View options.
 */
export function buildClimbViewModel({ buttons, miniPlayer, belowTheClimb }: ClimbViewModelInput): MoreFormModel {
  const buttonRows: MoreRow[] = [
    {
      kind: 'toggle',
      key: 'previousNext',
      label: buttons.previousNextLabel,
      subtitle: buttons.previousNextDescription,
      value: buttons.previousNext,
      onValueChange: buttons.onPreviousNextChange,
    },
    {
      kind: 'toggle',
      key: 'wallBadge',
      label: buttons.wallBadgeLabel,
      subtitle: buttons.wallBadgeDescription,
      value: buttons.wallBadge,
      onValueChange: buttons.onWallBadgeChange,
    },
    ...buttons.controls.map((control): MoreRow => ({
      kind: 'toggle',
      key: `button.${control.id}`,
      label: control.label,
      subtitle: control.description,
      value: control.visible,
      onValueChange: (visible: boolean) => buttons.onVisibleChange(control.id, visible),
    })),
    {
      kind: 'button',
      key: 'restoreButtonDefaults',
      label: buttons.restoreDefaultsLabel,
      disabled: !buttons.canRestoreDefaults,
      onPress: buttons.onRestoreDefaults,
    },
  ];

  const miniPlayerRows: MoreRow[] =
    miniPlayer === null
      ? []
      : [
          ...miniPlayer.controls.map((control): MoreRow => ({
            kind: 'toggle',
            key: `miniPlayer.${control.id}`,
            label: control.label,
            subtitle: control.description,
            value: control.visible,
            onValueChange: (visible: boolean) => miniPlayer.onVisibleChange(control.id, visible),
          })),
          {
            kind: 'button',
            key: 'restoreMiniPlayerDefaults',
            label: miniPlayer.restoreDefaultsLabel,
            disabled: !miniPlayer.canRestoreDefaults,
            onPress: miniPlayer.onRestoreDefaults,
          },
        ];

  return {
    sections: [
      {
        key: 'buttonsPosition',
        title: buttons.title,
        footer: buttons.positionFooter,
        rows: [
          { kind: 'custom', key: 'preview', content: buttons.preview, height: buttons.previewHeight },
          {
            kind: 'segmented',
            key: 'buttonsPosition',
            label: buttons.positionLabel,
            options: buttons.positionOptions,
            selectedKey: buttons.position,
            onSelect: buttons.onPositionChange,
          },
        ],
      },
      { key: 'buttons', footer: buttons.settingsFooter, rows: buttonRows },
      ...(miniPlayer === null
        ? []
        : [{ key: 'miniPlayer', title: miniPlayer.title, footer: miniPlayer.settingsFooter, rows: miniPlayerRows }]),
      belowTheClimb,
    ],
  };
}
