// What the In range slot's buttons do, moved out of app/boards/index.tsx with
// the scan state (use-picker-in-range.ts). Every one is the first-board "scan"
// path, which before the slot was the "Scan for the board in front of me"
// link. The screen keeps "Use my location", which belongs to Near you, and the
// picks, which belong to the whole picker.

import { useCallback } from 'react';
import type { useRouter } from 'expo-router';
import { trackBoardKindChosen } from '../../lib/boards/board-picker-add-analytics';
import type { BoardReturnTo } from '../../lib/boards/board-return-to';
import { BUILDER_PRESET_PARAM_VALUE } from '../../lib/boards/first-board-mode';
import { setPendingBoardRecognition } from '../../lib/boards/pending-board-recognition';
import type { FirstBoardPath } from '../../lib/onboarding/first-board-picker-analytics';
import { openAppSettings } from '../../lib/open-app-settings';
import { addBoardRoute } from './add-board-route';
import { turnOnBluetooth } from './bluetooth-radio';
import type { UnnamedInRangeRow } from './picker-top-view';
import { builderSerialForRow } from './quickstart-scan-rows';
import type { PickerScan } from './use-picker-board-scan';

type Router = ReturnType<typeof useRouter>;

export type InRangeActions = {
  /** Continue, Allow Bluetooth, Scan and Scan again. */
  onStart: () => void;
  /** Turn on Bluetooth (Android): the system dialog, or a scan when the radio is already on. */
  onTurnOnBluetooth: () => void;
  onOpenSettings: () => void;
  onRetryLookup: () => void;
  /**
   * The start of every way forward from a box it heard but couldn't name.
   * Returns whether it holds the box for the next bind.
   */
  startUnnamedRowAction: (row: UnnamedInRangeRow) => boolean;
  /** "Search gyms": the gym map, filtered to that type. */
  onSearchGyms: (row: UnnamedInRangeRow) => void;
  /** "It's my own board": the builder on that type, with its serial when one box was heard. */
  onOwnBoard: (row: UnnamedInRangeRow) => void;
};

export function useInRangeActions({
  scan,
  router,
  chooseFirstBoardPath,
  dropHeldBox,
  boardReturnTo,
  source,
  gymFirstEnabled,
}: {
  scan: PickerScan;
  router: Router;
  chooseFirstBoardPath: (path: FirstBoardPath) => void;
  /** Forget a box held from an earlier row, and the Near you pick that would have named it. */
  dropHeldBox: () => void;
  boardReturnTo: BoardReturnTo;
  /** The picker's own `source` param, carried to the routes so a bind there closes out first run. */
  source: string | undefined;
  gymFirstEnabled: boolean;
}): InRangeActions {
  const { start, stop, listenedLongEnough, retryLookup } = scan;

  const onStart = useCallback(() => {
    chooseFirstBoardPath('scan');
    start();
  }, [chooseFirstBoardPath, start]);

  const onTurnOnBluetooth = useCallback(() => {
    chooseFirstBoardPath('scan');
    void turnOnBluetooth().then((outcome) => {
      if (outcome === 'already_on') start();
    });
  }, [chooseFirstBoardPath, start]);

  const onOpenSettings = useCallback(() => {
    chooseFirstBoardPath('scan');
    void openAppSettings();
  }, [chooseFirstBoardPath]);

  const onRetryLookup = useCallback(() => {
    chooseFirstBoardPath('scan');
    retryLookup();
  }, [chooseFirstBoardPath, retryLookup]);

  // Each way forward ends the scan and holds the box so the board the climber
  // binds next, here or on the route it opens, names it from then on
  // (pending-board-recognition.ts). Only when one box stands behind the row,
  // and the scan listened long enough for "one" to mean one: read before
  // `stop()`, which ends the listening. The bind keeps `source`, so it still
  // closes out first run. Location is asked on the tap, never when the scan
  // finds the board. The row acted on last is the box the climber is at, so a
  // row with no single box drops an older hold.
  const startUnnamedRowAction = useCallback(
    (row: UnnamedInRangeRow): boolean => {
      const soleBoxHeardLongEnough = listenedLongEnough();
      stop();
      chooseFirstBoardPath('scan');
      dropHeldBox();
      if (row.kind === 'unknown_setup' || !row.deviceId || !soleBoxHeardLongEnough) return false;
      setPendingBoardRecognition({ deviceId: row.deviceId, boardType: row.boardType });
      return true;
    },
    [listenedLongEnough, stop, chooseFirstBoardPath, dropHeldBox],
  );

  const onSearchGyms = useCallback(
    (row: UnnamedInRangeRow) => {
      startUnnamedRowAction(row);
      const gymMap = addBoardRoute('gym_map', { returnTo: boardReturnTo, source, fromPicker: true });
      router.push({ pathname: gymMap.pathname, params: { ...gymMap.params, boardType: row.boardType } });
    },
    [startUnnamedRowAction, router, boardReturnTo, source],
  );

  // The builder, opened on that type with its preset. A box that advertised a
  // serial nobody has saved opens with that serial filled in, when it was the
  // only one of its type heard (`builderSerialForRow`); read, like the hold,
  // before the scan stops.
  const onOwnBoard = useCallback(
    (row: UnnamedInRangeRow) => {
      const serial = builderSerialForRow(row, listenedLongEnough());
      startUnnamedRowAction(row);
      const boardKind = gymFirstEnabled ? 'home' : undefined;
      if (boardKind) trackBoardKindChosen({ kind: boardKind, surface: 'in_range', preAnswered: true });
      const builder = addBoardRoute('board', {
        returnTo: boardReturnTo,
        source,
        preset: BUILDER_PRESET_PARAM_VALUE,
        boardKind,
      });
      router.push({
        pathname: builder.pathname,
        params: { ...builder.params, presetBoardType: row.boardType, ...(serial ? { serial } : {}) },
      });
    },
    [listenedLongEnough, startUnnamedRowAction, router, boardReturnTo, source, gymFirstEnabled],
  );

  return { onStart, onTurnOnBluetooth, onOpenSettings, onRetryLookup, startUnnamedRowAction, onSearchGyms, onOwnBoard };
}
