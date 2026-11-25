// The board picker's In range slot as one hook: the Bluetooth scan, the top it
// leads with (At {gym}, the hero, the box it can't name, or the scan's own
// notice) and what the rest of the screen needs from it. Moved out of
// app/boards/index.tsx; the rules themselves live where they always did:
// - use-picker-board-scan.ts: when to scan, and the scan's lifecycle;
// - use-steady-picker-top.ts: holding the top still while one scan runs;
// - picker-top-view.ts: what leads, in two steps around the gym's roster;
// - bluetooth-radio.ts: the way out of "Bluetooth is off".
//
// The screen keeps the picks, the navigation and Near you; this hook keeps the
// scan's state. The climber's Not now on the Bluetooth card is kept on the
// device (`pickerBluetoothNotNow`), so the card asks once and the line after it
// stays.

import { useCallback, useMemo } from 'react';
import { Platform } from 'react-native';
import type { UserBoard } from '@boardsesh/shared-schema';
import { useGymBoards } from '../../lib/graphql/hooks';
import { usePickerAutoScanEnabled } from '../../providers/feature-flags-provider';
import { useSetting } from '../../settings/hooks';
import { bluetoothOffFix, type BluetoothOffFix } from './bluetooth-radio';
import type { InRangeLocationHint } from './InRangeSection';
import {
  buildPickerTopView,
  decidePickerTop,
  decisionAtDrawnTop,
  pickerTopBoardUuids,
  pickerTopGymUuid,
  pickerTopPicks,
  stabilizePickerTop,
  type PickerTopBoard,
  type PickerTopPick,
  type PickerTopView,
} from './picker-top-view';
import { useInRangeLocationHint } from './use-in-range-location-hint';
import { usePickerBoardScan, type PickerScan } from './use-picker-board-scan';
import { scanHeardAnything, usePickerScanHold, usePickerTopSteadiness } from './use-steady-picker-top';

export type PickerInRange = {
  scan: PickerScan;
  /** The top as the screen draws it, held steady through one scan. */
  topView: PickerTopView<PickerTopBoard>;
  /** Your boards and Near you leave these out, so a board shows once. */
  topBoardUuids: ReadonlySet<string>;
  /** Each board the top lists, by key, with how a pick of it is reported. */
  topPicks: ReadonlyMap<string, PickerTopPick>;
  /** Android hiding what the scan heard, and its fix; null otherwise. */
  locationHint: InRangeLocationHint | null;
  bluetoothOffFix: BluetoothOffFix;
  /** Not now on the Bluetooth card: one line with Allow Bluetooth from then on. */
  sayBluetoothNotNow: () => void;
};

export function usePickerInRange({
  focused,
  showsTop,
  knownBoards,
  activeBoard,
}: {
  /** The picker is the screen on top (`useIsFocused`). */
  focused: boolean;
  /** The online layout, the only one that draws the top: signed in, not local-only, no error. */
  showsTop: boolean;
  /** The climber's own and followed boards, which a recognised serial-less box may be named as. */
  knownBoards: readonly UserBoard[];
  /** The board you're on: null for none, undefined while it is still being read. */
  activeBoard: UserBoard | null | undefined;
}): PickerInRange {
  // Scans by itself on open unless the remote switch says to wait for a tap.
  // Only while this screen is on top and showing the online layout: the
  // offline list and the error state have no top to fill.
  const autoStart = usePickerAutoScanEnabled();
  const scan = usePickerBoardScan({ focused: focused && showsTop, autoStart, knownBoards });
  const { phase, rows, lookup, start } = scan;

  const [bluetoothNotNow, setBluetoothNotNow] = useSetting('pickerBluetoothNotNow');
  const sayBluetoothNotNow = useCallback(() => setBluetoothNotNow(true), [setBluetoothNotNow]);

  // Nothing a scan heard leads for its first seconds after hearing anything,
  // or while the lookup is still naming it; once it has led it stays put
  // until the results leave the screen (use-steady-picker-top.ts).
  const steadiness = usePickerTopSteadiness(phase, lookup);
  const drawnTop = steadiness.drawn;
  const scanHold = usePickerScanHold(phase, scanHeardAnything(rows, lookup));
  const holdScanLead = scanHold || steadiness.waitsOnLookup;
  const scanDecision = useMemo(
    () => decidePickerTop({ phase, rows, lookup, activeBoard, holdScanLead, bluetoothNotNow }),
    [phase, rows, lookup, activeBoard, holdScanLead, bluetoothNotNow],
  );
  // The top already drawn keeps its gym (a hero may become its own gym's), so
  // the roster fetched is the gym on screen.
  const topDecision = useMemo(() => decisionAtDrawnTop(scanDecision, drawnTop), [scanDecision, drawnTop]);
  const { data: topGymRoster } = useGymBoards(showsTop ? pickerTopGymUuid(topDecision) : null);
  const topView = useMemo(
    () => stabilizePickerTop(drawnTop, buildPickerTopView(topDecision, topGymRoster)),
    [drawnTop, topDecision, topGymRoster],
  );
  // Remembers what the scan led with, so the next render holds it.
  steadiness.record(topView);
  const topBoardUuids = useMemo(() => pickerTopBoardUuids(topView), [topView]);
  const topPicks = useMemo(() => pickerTopPicks(topView), [topView]);
  // Android can withhold what a scan heard; when it heard nothing, the top
  // says why and offers the fix, which rescans when it works.
  const locationHint = useInRangeLocationHint(topView.heardNothing, start);

  return {
    scan,
    topView,
    topBoardUuids,
    topPicks,
    locationHint,
    bluetoothOffFix: bluetoothOffFix(Platform.OS),
    sayBluetoothNotNow,
  };
}
