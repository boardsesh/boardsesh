import type { MoreRow, MoreSection, MoreSelectRow } from '../../MoreForm.types';
import type { SettingsTranslate } from '../root/settings-pages';
import { KEEP_LIGHTING_CHOICES, keepLightingSeconds, type KeepLightingChoice } from '../../../lib/keep-lighting';

type Toggle = { enabled: boolean; onChange: (enabled: boolean) => void };
type KeepLightingPicker = { choice: KeepLightingChoice; onChange: (choice: KeepLightingChoice) => void };

export type BoardLightingModelInput = {
  t: SettingsTranslate;
  /** After Put on board, keep lighting (2.7): every board but a MoonBoard. */
  keepLighting: KeepLightingPicker;
  /**
   * The MoonBoard's own choice, or `null` when no MoonBoard is in view (the
   * connected board, the active board, or a saved one).
   */
  moonboardKeepLighting: KeepLightingPicker | null;
  /** In a session too: keep-lighting applies in a crew session as well. */
  drivesInSession: Toggle;
  lightOnSwipe: Toggle;
  lightOnClimbTap: Toggle;
  /**
   * Whether a playlist, For You or setter-page tap loads that list into the
   * queue (F4, #6667). Leads the group after the two lighting switches: like
   * Light the board when I tap a climb, it says what a list tap does.
   */
  playlistTapLoadsQueue: Toggle;
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

/** The words for each keep-lighting choice; 30/45/60 reuse the auto-disconnect timeout labels. */
function keepLightingLabel(t: SettingsTranslate, choice: KeepLightingChoice): string {
  switch (choice) {
    case 'off':
      return t('settings:ble.lighting.keep.off');
    case '30':
      return t('settings:ble.autoDisconnect.timeoutOptions.30');
    case '45':
      return t('settings:ble.autoDisconnect.timeoutOptions.45');
    case '60':
      return t('settings:ble.autoDisconnect.timeoutOptions.60');
    case 'until_stopped':
      return t('settings:ble.lighting.keep.untilStopped');
  }
}

function keepLightingRow(
  t: SettingsTranslate,
  key: 'putOnBoardKeepsLighting' | 'moonboardPutOnBoardKeepsLighting',
  label: string,
  picker: KeepLightingPicker,
  subtitle?: string,
): MoreSelectRow {
  return {
    kind: 'select',
    key,
    label,
    ...(subtitle ? { subtitle } : {}),
    options: KEEP_LIGHTING_CHOICES.map((choice) => ({ key: choice, label: keepLightingLabel(t, choice) })),
    selectedKey: picker.choice,
    onSelect: (selected) => {
      const choice = KEEP_LIGHTING_CHOICES.find((candidate) => candidate === selected);
      if (choice) picker.onChange(choice);
    },
  };
}

/**
 * The Board page's lighting half (spec B4). First what Put on board keeps
 * lighting (2.7): the general choice, the MoonBoard's own right under it (only
 * where a MoonBoard is in view), and In a session too, greyed with its reason
 * while the general choice is Off (its state follows only the general choice;
 * a MoonBoard's applies in a session anyway). Then what lights the connected
 * board on its own (Light automatically), then what a list tap does (and the
 * MoonBoard's extra LEDs), then the Bluetooth group, which says when the phone
 * lets go of the board so another climber can connect, and that it cuts the
 * keep-lighting short when it comes first.
 *
 * The two lighting switches get a group of their own, tap first and swipe
 * under it, because swipe only matters once tap (or Put on the wall) has a
 * climb on the wall: a preview never lights the board as you swipe, whatever
 * the swipe switch says (`swipeStaysViewOnly`). The swipe row's subtitle says
 * so, since six climbers in six read the old side-by-side pair as independent.
 */
export function buildBoardLightingSections(input: BoardLightingModelInput): MoreSection[] {
  const { t, autoDisconnectTimeout } = input;

  const keepOff = input.keepLighting.choice === 'off';
  const keepRows: MoreRow[] = [
    keepLightingRow(t, 'putOnBoardKeepsLighting', t('settings:ble.lighting.keep.label'), input.keepLighting),
  ];
  if (input.moonboardKeepLighting) {
    keepRows.push(
      keepLightingRow(
        t,
        'moonboardPutOnBoardKeepsLighting',
        t('settings:ble.lighting.keep.moonboardLabel'),
        input.moonboardKeepLighting,
        t('settings:ble.lighting.keep.moonboardDescription'),
      ),
    );
  }
  keepRows.push({
    kind: 'toggle',
    key: 'putOnBoardDrivesInSession',
    label: t('settings:ble.lighting.keep.inSessionLabel'),
    // Greyed with the general choice Off: the reason replaces the description, at full contrast.
    subtitle: keepOff
      ? t('settings:ble.lighting.keep.inSessionOffReason')
      : t('settings:ble.lighting.keep.inSessionDescription'),
    value: input.drivesInSession.enabled,
    disabled: keepOff,
    onValueChange: input.drivesInSession.onChange,
  });

  // Auto-disconnect lets go of the board before keep-lighting would stop.
  const longestKeepSeconds = Math.max(
    keepLightingSeconds(input.keepLighting.choice),
    input.moonboardKeepLighting ? keepLightingSeconds(input.moonboardKeepLighting.choice) : 0,
  );
  const cutsLighting = input.autoDisconnect.enabled && autoDisconnectTimeout.seconds < longestKeepSeconds;
  const timeoutLabel =
    autoDisconnectTimeout.options.find((option) => option.seconds === autoDisconnectTimeout.seconds)?.label ??
    String(autoDisconnectTimeout.seconds);
  const bluetoothFooter = cutsLighting
    ? `${t('settings:ble.autoDisconnect.description')} ${t('settings:ble.autoDisconnect.cutsLighting', { timeout: timeoutLabel })}`
    : t('settings:ble.autoDisconnect.description');

  const lightingRows: MoreRow[] = [
    {
      kind: 'toggle',
      key: 'lightOnClimbTap',
      label: t('settings:ble.lighting.onTapLabel'),
      subtitle: t('settings:ble.lighting.onTapDescription'),
      value: input.lightOnClimbTap.enabled,
      onValueChange: input.lightOnClimbTap.onChange,
    },
    {
      kind: 'toggle',
      key: 'lightOnSwipe',
      label: t('settings:ble.lighting.onSwipeLabel'),
      subtitle: t('settings:ble.lighting.onSwipeDescription'),
      value: input.lightOnSwipe.enabled,
      onValueChange: input.lightOnSwipe.onChange,
    },
  ];
  const moreLightingRows: MoreRow[] = [
    {
      kind: 'toggle',
      key: 'playlistTapLoadsQueue',
      label: t('settings:ble.lighting.playlistTapLoadsQueueLabel'),
      subtitle: t('settings:ble.lighting.playlistTapLoadsQueueDescription'),
      value: input.playlistTapLoadsQueue.enabled,
      onValueChange: input.playlistTapLoadsQueue.onChange,
    },
  ];
  if (input.moonboardLightAdjacentHolds) {
    moreLightingRows.push({
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
      key: 'keepLighting',
      title: t('settings:ble.lighting.title'),
      footer: t('settings:ble.lighting.keep.footer'),
      rows: keepRows,
    },
    {
      key: 'lightingAuto',
      title: t('settings:ble.lighting.autoTitle'),
      footer: t('settings:ble.lighting.description'),
      rows: lightingRows,
    },
    {
      // Untitled: Light automatically's second card, so the pair above stays a pair.
      key: 'lightingMore',
      rows: moreLightingRows,
    },
    {
      key: 'bluetooth',
      title: t('settings:ble.sectionTitle'),
      footer: bluetoothFooter,
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
