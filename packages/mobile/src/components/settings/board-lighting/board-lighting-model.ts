import type { MoreRow, MoreSection, MoreSelectRow } from '../../MoreForm.types';
import type { SettingsTranslate } from '../root/settings-pages';
import { KEEP_LIGHTING_CHOICES, type KeepLightingChoice } from '../../../lib/keep-lighting';

type Toggle = { enabled: boolean; onChange: (enabled: boolean) => void };
type KeepLightingPicker = { choice: KeepLightingChoice; onChange: (choice: KeepLightingChoice) => void };

export type BoardLightingModelInput = {
  t: SettingsTranslate;
  /** Stop driving after (2.7): every board but a MoonBoard. */
  keepLighting: KeepLightingPicker;
  /**
   * The MoonBoard's own choice, or `null` when no MoonBoard is in view (the
   * connected board, the active board, or a saved one).
   */
  moonboardKeepLighting: KeepLightingPicker | null;
  /** In a session too: Put on board drives in a crew session as well. */
  drivesInSession: Toggle;
  /** Disconnect Bluetooth when driving ends (2.7, replacing auto-disconnect). */
  disconnectWhenDrivingEnds: Toggle;
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
  /**
   * Opens the www help on driving the wall (`/help/board-and-bluetooth#driving`).
   * The preview-first card and the What's New spotlight both retire, so this
   * row is where the frost, the clock and Stop driving after stay explained.
   * No row without it.
   */
  onOpenDrivingHelp?: () => void;
};

/**
 * The words for each Stop driving after choice. Settings › Board and the board
 * sheet's row both read it.
 */
export function keepLightingLabel(t: SettingsTranslate, choice: KeepLightingChoice): string {
  switch (choice) {
    case 'off':
      return t('settings:ble.lighting.keep.off');
    case '30':
      return t('settings:ble.lighting.keep.options.30');
    case '45':
      return t('settings:ble.lighting.keep.options.45');
    case '60':
      return t('settings:ble.lighting.keep.options.60');
    case '120':
      return t('settings:ble.lighting.keep.options.120');
    case '300':
      return t('settings:ble.lighting.keep.options.300');
    case 'until_stopped':
      return t('settings:ble.lighting.keep.untilStopped');
  }
}

/**
 * The Stop driving after card's footer, for the general choice: a drive with a
 * clock that each lit climb restarts, a drive until the climber stops it, or
 * Right away's one climb and no drive.
 */
export function keepLightingFooter(t: SettingsTranslate, choice: KeepLightingChoice): string {
  switch (choice) {
    case 'off':
      return t('settings:ble.lighting.keep.footerOff');
    case 'until_stopped':
      return t('settings:ble.lighting.keep.footerUntilStopped');
    case '30':
    case '45':
    case '60':
    case '120':
    case '300':
      return t('settings:ble.lighting.keep.footer');
  }
}

function keepLightingRow(
  t: SettingsTranslate,
  key: 'putOnBoardKeepsLighting' | 'moonboardPutOnBoardKeepsLighting',
  label: string,
  picker: KeepLightingPicker,
  extra: { subtitle?: string; accessibilityLabel?: string } = {},
): MoreSelectRow {
  return {
    kind: 'select',
    key,
    label,
    ...(extra.accessibilityLabel ? { accessibilityLabel: extra.accessibilityLabel } : {}),
    ...(extra.subtitle ? { subtitle: extra.subtitle } : {}),
    options: KEEP_LIGHTING_CHOICES.map((choice) => ({ key: choice, label: keepLightingLabel(t, choice) })),
    selectedKey: picker.choice,
    onSelect: (selected) => {
      const choice = KEEP_LIGHTING_CHOICES.find((candidate) => candidate === selected);
      if (choice) picker.onChange(choice);
    },
  };
}

/**
 * The Board page's lighting half (spec B4). First how long Put on board's
 * drive lasts (2.7, Stop driving after): the general choice, the MoonBoard's
 * own right under it (only where a MoonBoard is in view), and In a session
 * too, greyed with its reason while the general choice is Right away (its
 * state follows only the general choice; a MoonBoard's applies in a session
 * anyway). Under that card, what happens when a drive ends: Disconnect
 * Bluetooth when driving ends, which frees the board for the next climber (it
 * replaced auto-disconnect). Then what lights the connected board on its own
 * (Light automatically), then what a list tap does (and the MoonBoard's extra
 * LEDs).
 *
 * The two lighting switches get a group of their own, tap first and swipe
 * under it, because swipe only matters once tap (or Put on the wall) has a
 * climb on the wall: a preview never lights the board as you swipe, whatever
 * the swipe switch says (`swipeStaysViewOnly`). The swipe row's subtitle says
 * so, since six climbers in six read the old side-by-side pair as independent.
 */
export function buildBoardLightingSections(input: BoardLightingModelInput): MoreSection[] {
  const { t } = input;

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
        {
          subtitle: t('settings:ble.lighting.keep.moonboardDescription'),
          // Named on its own (spec B4): the rotor and Voice Control read it without the row above.
          accessibilityLabel: t('settings:ble.lighting.keep.moonboardAccessibilityLabel'),
        },
      ),
    );
  }
  keepRows.push({
    kind: 'toggle',
    key: 'putOnBoardDrivesInSession',
    label: t('settings:ble.lighting.keep.inSessionLabel'),
    accessibilityLabel: t('settings:ble.lighting.keep.inSessionAccessibilityLabel'),
    subtitle: t('settings:ble.lighting.keep.inSessionDescription'),
    // Greyed with the general choice Off: the reason replaces the description, at full contrast.
    disabledReason: t('settings:ble.lighting.keep.inSessionOffReason'),
    value: input.drivesInSession.enabled,
    disabled: keepOff,
    onValueChange: input.drivesInSession.onChange,
  });

  const drivingEndsRows: MoreRow[] = [
    {
      kind: 'toggle',
      key: 'disconnectWhenDrivingEnds',
      label: t('settings:ble.lighting.drivingEnds.label'),
      subtitle: t('settings:ble.lighting.drivingEnds.description'),
      value: input.disconnectWhenDrivingEnds.enabled,
      onValueChange: input.disconnectWhenDrivingEnds.onChange,
    },
  ];
  if (input.onOpenDrivingHelp) {
    drivingEndsRows.push({
      kind: 'nav',
      key: 'drivingHelp',
      label: t('settings:ble.lighting.drivingHelp'),
      external: true,
      onPress: input.onOpenDrivingHelp,
    });
  }

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
      footer: keepLightingFooter(t, input.keepLighting.choice),
      rows: keepRows,
    },
    {
      // Untitled: Stop driving after's second card, what happens when the drive
      // ends, then how driving works on the www help.
      key: 'drivingEnds',
      rows: drivingEndsRows,
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
  ];
}
