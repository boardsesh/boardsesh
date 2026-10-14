import type { MoreRow, MoreSection } from '../../MoreForm.types';
import type { SettingsTranslate } from '../root/settings-pages';

type Toggle = { enabled: boolean; onChange: (enabled: boolean) => void };

export type BoardLightingModelInput = {
  t: SettingsTranslate;
  lightOnSwipe: Toggle;
  lightOnClimbTap: Toggle;
  /**
   * The MoonBoard "V2" extra LEDs, or `null` when the connected board is not a
   * MoonBoard. Same setting and handler as the board's control sheet, so it is
   * reachable without a live connection.
   */
  moonboardLightAdjacentHolds: Toggle | null;
  autoDisconnect: Toggle;
  autoDisconnectTimeout: {
    seconds: number;
    /** Every choice, in seconds, with its label. */
    options: readonly { seconds: number; label: string }[];
    onChange: (seconds: number) => void;
  };
};

/**
 * The Board page's lighting half: what lights the connected board on its own,
 * then the Bluetooth group, which says when the phone lets go of the board so
 * another climber can connect.
 */
export function buildBoardLightingSections(input: BoardLightingModelInput): MoreSection[] {
  const { t, autoDisconnectTimeout } = input;

  const lightingRows: MoreRow[] = [
    {
      kind: 'toggle',
      key: 'lightOnSwipe',
      label: t('settings:ble.lighting.onSwipeLabel'),
      subtitle: t('settings:ble.lighting.onSwipeDescription'),
      value: input.lightOnSwipe.enabled,
      onValueChange: input.lightOnSwipe.onChange,
    },
    {
      kind: 'toggle',
      key: 'lightOnClimbTap',
      label: t('settings:ble.lighting.onTapLabel'),
      subtitle: t('settings:ble.lighting.onTapDescription'),
      value: input.lightOnClimbTap.enabled,
      onValueChange: input.lightOnClimbTap.onChange,
    },
  ];
  if (input.moonboardLightAdjacentHolds) {
    lightingRows.push({
      kind: 'toggle',
      key: 'moonboardLightAdjacentHolds',
      label: t('lightControl.lightAdjacentHolds'),
      subtitle: t('lightControl.lightAdjacentHoldsHelp'),
      value: input.moonboardLightAdjacentHolds.enabled,
      onValueChange: input.moonboardLightAdjacentHolds.onChange,
    });
  }

  return [
    {
      key: 'lighting',
      title: t('settings:ble.lighting.title'),
      footer: t('settings:ble.lighting.description'),
      rows: lightingRows,
    },
    {
      key: 'bluetooth',
      title: t('settings:ble.sectionTitle'),
      footer: t('settings:ble.autoDisconnect.description'),
      rows: [
        {
          kind: 'toggle',
          key: 'autoDisconnectBle',
          label: t('settings:ble.autoDisconnect.enabledLabel'),
          subtitle: t('settings:ble.autoDisconnect.enabledDescription'),
          value: input.autoDisconnect.enabled,
          onValueChange: input.autoDisconnect.onChange,
        },
        {
          kind: 'select',
          key: 'autoDisconnectTimeoutSeconds',
          label: t('settings:ble.autoDisconnect.timeoutLabel'),
          options: autoDisconnectTimeout.options.map((option) => ({
            key: String(option.seconds),
            label: option.label,
          })),
          selectedKey: String(autoDisconnectTimeout.seconds),
          onSelect: (key) => {
            const choice = autoDisconnectTimeout.options.find((option) => String(option.seconds) === key);
            if (choice) autoDisconnectTimeout.onChange(choice.seconds);
          },
        },
      ],
    },
  ];
}
