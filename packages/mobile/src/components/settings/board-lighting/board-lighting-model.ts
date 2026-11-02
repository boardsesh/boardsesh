import type { MoreRow, MoreSection, MoreSelectRow } from '../../MoreForm.types';
import type { SettingsTranslate } from '../root/settings-pages';
import { KEEP_LIGHTING_CHOICES, type KeepLightingChoice } from '../../../lib/keep-lighting';

type Toggle = { enabled: boolean; onChange: (enabled: boolean) => void };
type KeepLightingPicker = { choice: KeepLightingChoice; onChange: (choice: KeepLightingChoice) => void };

export type BoardLightingModelInput = {
  t: SettingsTranslate;
  /** Stop driving after (2.7): every board, MoonBoards included. */
  keepLighting: KeepLightingPicker;
  /** In a session too: Put on board drives in a crew session as well. */
  drivesInSession: Toggle;
  /** Disconnect Bluetooth when driving ends (2.7, replacing auto-disconnect). */
  disconnectWhenDrivingEnds: Toggle;
  /**
   * Always drive the wall: this phone drives the wall while it holds the
   * board. On, Stop driving after shows greyed with its reason on the row,
   * and In a session too applies whatever Stop driving after says.
   */
  alwaysDrive: Toggle;
  /**
   * Whether a playlist, For You or setter-page tap loads that list into the
   * queue (F4, #6667). Under Always drive the wall: like it, it says what a
   * list tap does.
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
 * The Stop driving after card's footer: a drive with a
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
  picker: KeepLightingPicker,
  extra: { subtitle?: string; disabled?: boolean } = {},
): MoreSelectRow {
  return {
    kind: 'select',
    key: 'putOnBoardKeepsLighting',
    label: t('settings:ble.lighting.keep.label'),
    ...(extra.subtitle ? { subtitle: extra.subtitle } : {}),
    ...(extra.disabled ? { disabled: true } : {}),
    options: KEEP_LIGHTING_CHOICES.map((choice) => ({ key: choice, label: keepLightingLabel(t, choice) })),
    selectedKey: picker.choice,
    onSelect: (selected) => {
      const choice = KEEP_LIGHTING_CHOICES.find((candidate) => candidate === selected);
      if (choice) picker.onChange(choice);
    },
  };
}

/**
 * The Board page's lighting half (spec B4). First Always drive the wall, one
 * switch (it replaced Light the board when I tap a climb and Light the board
 * as I swipe): on, this phone always drives the wall while it holds the board.
 * It leads because it greys the rows under it: a climber reads the switch
 * before the rows it turns off. Its footer, only while it is on, says how to
 * stop and what a stop holds.
 *
 * Then how long Put on board's drive lasts (2.7, Stop driving after), one
 * choice for every board, MoonBoards included, and In a session too, greyed
 * with its reason while the choice is Right away. Under Always drive the wall
 * the choice doesn't apply: it stays in place, greyed, saying why on the row
 * itself (where a screen reader lands), and the card drops its footer, which
 * describes Put on board's drive. In a session too still decides a crew
 * session for Always drive the wall, so it is never greyed then.
 *
 * Under that card, what happens when a drive ends: Disconnect Bluetooth when
 * driving ends, which frees the board for the next climber (it replaced
 * auto-disconnect). Then what a list tap does (and the MoonBoard's extra LEDs).
 */
export function buildBoardLightingSections(input: BoardLightingModelInput): MoreSection[] {
  const { t } = input;

  const alwaysDrive = input.alwaysDrive.enabled;
  const keepOff = input.keepLighting.choice === 'off';
  // Greyed under Always drive the wall, each row says why where a screen reader lands on it.
  const alwaysDriveReason = t('settings:ble.lighting.keep.alwaysDriveReason');
  const keepRows: MoreRow[] = [
    keepLightingRow(t, input.keepLighting, {
      ...(alwaysDrive ? { subtitle: alwaysDriveReason } : {}),
      disabled: alwaysDrive,
    }),
  ];
  keepRows.push({
    kind: 'toggle',
    key: 'putOnBoardDrivesInSession',
    label: t('settings:ble.lighting.keep.inSessionLabel'),
    accessibilityLabel: t('settings:ble.lighting.keep.inSessionAccessibilityLabel'),
    subtitle: t('settings:ble.lighting.keep.inSessionDescription'),
    // Greyed with Stop driving after Off: the reason replaces the description,
    // at full contrast. Always drive the wall drives in a session only with it
    // on, so it is never greyed then.
    disabledReason: t('settings:ble.lighting.keep.inSessionOffReason'),
    value: input.drivesInSession.enabled,
    disabled: keepOff && !alwaysDrive,
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
      key: 'alwaysDrive',
      label: t('settings:ble.lighting.alwaysDriveLabel'),
      subtitle: t('settings:ble.lighting.alwaysDriveDescription'),
      value: alwaysDrive,
      onValueChange: input.alwaysDrive.onChange,
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
      key: 'lightingAuto',
      title: t('settings:ble.lighting.title'),
      // How to stop, and what a stop holds: only true while it is on.
      ...(alwaysDrive ? { footer: t('settings:ble.lighting.alwaysDriveFooter') } : {}),
      rows: lightingRows,
    },
    {
      // Untitled: the same lighting page. Under Always drive the wall the rows
      // say why they are greyed, and the footer (Put on board's drive) goes.
      key: 'keepLighting',
      ...(alwaysDrive ? {} : { footer: keepLightingFooter(t, input.keepLighting.choice) }),
      rows: keepRows,
    },
    {
      // Untitled: Stop driving after's second card, what happens when the drive
      // ends, then how driving works on the www help.
      key: 'drivingEnds',
      rows: drivingEndsRows,
    },
    {
      // Untitled: what a list tap does, and the MoonBoard's extra LEDs.
      key: 'lightingMore',
      rows: moreLightingRows,
    },
  ];
}
