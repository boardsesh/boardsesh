// What the In range slot's buttons do, moved out of app/boards/index.tsx with
// the scan state (use-picker-in-range.ts). Every one is the first-board "scan"
// path, which before the slot was the "Scan for the board in front of me"
// link. The screen keeps "Use my location", which belongs to Near you, and the
// picks, which belong to the whole picker.

import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import type { useRouter } from 'expo-router';
import { trackBoardKindChosen } from '../../lib/boards/board-picker-add-analytics';
import type { BoardReturnTo } from '../../lib/boards/board-return-to';
import { BUILDER_PRESET_PARAM_VALUE } from '../../lib/boards/first-board-mode';
import { wizardSetupHref } from '../../lib/boards/add-board-wizard';
import { clearHeardSerialOffer, offerHeardSerial } from '../../lib/boards/heard-serial-offer';
import { setPendingBoardRecognition } from '../../lib/boards/pending-board-recognition';
import type { FirstBoardPath } from '../../lib/onboarding/first-board-picker-analytics';
import { openAppSettings } from '../../lib/open-app-settings';
import { addBoardRoute } from './add-board-route';
import { turnOnBluetooth, watchBluetoothPoweredOn } from './bluetooth-radio';
import type { UnnamedInRangeRow } from './picker-top-view';
import { builderSerialForRow } from './quickstart-scan-rows';
import type { PickerScan } from './use-picker-board-scan';

type Router = ReturnType<typeof useRouter>;

/** How long after coming back from the Turn on dialog the radio may take to report on. */
export const RADIO_RETURN_WATCH_MS = 10_000;

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
  wizardEnabled,
}: {
  scan: PickerScan;
  router: Router;
  chooseFirstBoardPath: (path: FirstBoardPath) => void;
  /** Forget a box held from an earlier row, and the Near you pick that would have named it. */
  dropHeldBox: () => void;
  boardReturnTo: BoardReturnTo;
  /** The picker's own `source` param, carried to the routes so a bind there closes out first run. */
  source: string | undefined;
  /** The add-a-board wizard is on: "It's my own board" opens its Set up, type and serial known. */
  wizardEnabled: boolean;
}): InRangeActions {
  const { start, stop, listenedLongEnough, retryLookup, lookup } = scan;
  const startRef = useRef(start);
  startRef.current = start;

  // Async tails (the Turn on dialog's answer, the radio watch) do nothing once
  // the picker is gone: no listener registered, no scan started.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // A serial offered to a builder this picker never opened goes with the picker.
  useEffect(() => clearHeardSerialOffer, []);

  // Back from Android's Turn on dialog (or the settings page it fell back to):
  // watch the radio for up to RADIO_RETURN_WATCH_MS and scan once it is on,
  // whether or not auto-scan is on. A watch, not one read: the radio can still
  // be Resetting when the app comes back. The scan's own guard drops this when
  // the radio-on report already started one.
  const appStateWatchRef = useRef<{ remove(): void } | null>(null);
  const stopRadioWatchRef = useRef<(() => void) | null>(null);
  const radioWatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopWatchingReturn = useCallback(() => {
    appStateWatchRef.current?.remove();
    appStateWatchRef.current = null;
    stopRadioWatchRef.current?.();
    stopRadioWatchRef.current = null;
    if (radioWatchTimerRef.current !== null) clearTimeout(radioWatchTimerRef.current);
    radioWatchTimerRef.current = null;
  }, []);
  useEffect(() => stopWatchingReturn, [stopWatchingReturn]);
  const scanWhenBackIfOn = useCallback(() => {
    stopWatchingReturn();
    if (!mountedRef.current) return;
    appStateWatchRef.current = AppState.addEventListener('change', (nextAppState) => {
      if (nextAppState !== 'active') return;
      stopWatchingReturn();
      stopRadioWatchRef.current = watchBluetoothPoweredOn(() => {
        stopWatchingReturn();
        if (mountedRef.current) startRef.current();
      });
      radioWatchTimerRef.current = setTimeout(stopWatchingReturn, RADIO_RETURN_WATCH_MS);
    });
  }, [stopWatchingReturn]);

  const onStart = useCallback(() => {
    chooseFirstBoardPath('scan');
    start();
  }, [chooseFirstBoardPath, start]);

  const onTurnOnBluetooth = useCallback(() => {
    chooseFirstBoardPath('scan');
    void turnOnBluetooth().then((outcome) => {
      if (!mountedRef.current) return;
      if (outcome === 'already_on') start();
      else scanWhenBackIfOn();
    });
  }, [chooseFirstBoardPath, start, scanWhenBackIfOn]);

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
      clearHeardSerialOffer();
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
  // only box of its type heard (`builderSerialForRow`); read, like the hold,
  // before the scan stops. The offer is what lets the builder trust the param
  // (heard-serial-offer.ts). With the add-a-board wizard on it is the wizard's
  // Set up, entered here: the button said home and the scan heard the type, so
  // Where's the board? and Which board? are skipped.
  const onOwnBoard = useCallback(
    (row: UnnamedInRangeRow) => {
      const serial = builderSerialForRow(row, listenedLongEnough(), lookup);
      startUnnamedRowAction(row);
      if (serial) offerHeardSerial({ serial, boardType: row.boardType });
      const serialParams = serial ? { serial } : {};
      if (wizardEnabled) {
        trackBoardKindChosen({ kind: 'home', surface: 'in_range', preAnswered: true });
        const setup = wizardSetupHref(
          { returnTo: boardReturnTo, source, entry: 'in_range', trail: [] },
          { path: 'home', boardType: row.boardType },
        );
        router.push({ pathname: setup.pathname, params: { ...setup.params, ...serialParams } });
        return;
      }
      const builder = addBoardRoute('board', { returnTo: boardReturnTo, source, preset: BUILDER_PRESET_PARAM_VALUE });
      router.push({
        pathname: builder.pathname,
        params: { ...builder.params, presetBoardType: row.boardType, ...serialParams },
      });
    },
    [listenedLongEnough, lookup, startUnnamedRowAction, router, boardReturnTo, source, wizardEnabled],
  );

  return { onStart, onTurnOnBluetooth, onOpenSettings, onRetryLookup, startUnnamedRowAction, onSearchGyms, onOwnBoard };
}
