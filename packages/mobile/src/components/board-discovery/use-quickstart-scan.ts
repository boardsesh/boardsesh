// The Bluetooth quickstart's scan, its serial lookup and the rows they make, as
// one hook for the two places that list in-range boards: the quickstart sheet
// (BluetoothQuickstartSheet.tsx) and the board picker's in-range slot
// (use-picker-board-scan.ts). The rules live in the pure builders
// (quickstart-scan-rows.ts); this only wires the scan and the queries to them,
// and the views only render `rows`.

import { useCallback, useMemo } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';
import { useBoardScan, type BoardScan, type BoardScanSlotPolicy } from '../../lib/ble/use-board-scan';
import { useBoardsBySerialNumbers } from '../../lib/graphql/hooks';
import { selectBleBoardCandidates } from '../../lib/ble/select-board-candidates';
import { useMyBoardSerialConfigs } from '../../lib/ble/use-my-board-serial-configs';
import { useRecognizedBoardDevices } from '../../lib/ble/recognized-board-devices-store';
import {
  buildQuickstartRows,
  quickstartLookupState,
  type QuickstartLookupState,
  type QuickstartRecognition,
  type QuickstartRow,
} from './quickstart-scan-rows';

const EMPTY_BOARDS: UserBoard[] = [];

export type QuickstartScan = Pick<
  BoardScan,
  'status' | 'unavailableReason' | 'devices' | 'start' | 'reset' | 'finish'
> & {
  /** Every board heard, as rows to list, strongest signal first. */
  rows: QuickstartRow[];
  /** Where the serial lookup stands; `pending` while serial rows still wait on it. */
  lookup: QuickstartLookupState;
  /** Run the serial lookup again, for the "need signal" row. */
  retryLookup: () => void;
};

export function useQuickstartScan({
  slotPolicy,
  mayStartRadio,
  knownBoards,
}: {
  /** How the scan gets ble-plx's one scan; see `BoardScanSlotPolicy`. Defaults to 'take'. */
  slotPolicy?: BoardScanSlotPolicy;
  /** Asked right before the radio starts; false drops the start (see `useBoardScan`). */
  mayStartRadio?: () => boolean;
  /**
   * The climber's own and followed boards, which a serial-less box this phone
   * recognises by its Bluetooth id may be named as. Absent: no box is
   * recognised, the sheet's behaviour.
   */
  knownBoards?: readonly UserBoard[];
} = {}): QuickstartScan {
  const { status, unavailableReason, serials, advertisedTypes, devices, start, reset, finish } = useBoardScan({
    slotPolicy,
    mayStartRadio,
  });
  // Scoped to what each controller announced. Aurora reuses a serial across
  // board apps, so unscoped this would offer a stranger's Kilter board for an
  // in-range Tension controller and let the climber make it active.
  const boardLookup = useBoardsBySerialNumbers(serials, advertisedTypes);
  const { data: boards, isLoading: isResolvingBoards, refetch: refetchBoards } = boardLookup;
  const { data: serialConfigs, isResolving: isResolvingPreferences } = useMyBoardSerialConfigs(serials);
  const visibleBoards = useMemo(
    () => selectBleBoardCandidates(boards ?? EMPTY_BOARDS, serialConfigs, advertisedTypes),
    [advertisedTypes, boards, serialConfigs],
  );
  // With no signal the lookup pauses instead of failing (`networkMode:
  // 'offlineFirst'`), so a paused lookup counts as failed: it used to read as
  // "No boards in range" while a board stood in front of the climber.
  const lookup = quickstartLookupState({
    serialCount: serials.length,
    hasResult: boards !== undefined,
    failed: boardLookup.isError || boardLookup.fetchStatus === 'paused',
    resolving: isResolvingBoards || isResolvingPreferences,
  });
  const recognizedDevices = useRecognizedBoardDevices(knownBoards !== undefined);
  const recognition = useMemo<QuickstartRecognition | undefined>(
    () => (knownBoards ? { devices: recognizedDevices, knownBoards } : undefined),
    [knownBoards, recognizedDevices],
  );
  const rows = useMemo(
    () => buildQuickstartRows({ devices, boards: visibleBoards, lookup, recognition }),
    [devices, visibleBoards, lookup, recognition],
  );
  const retryLookup = useCallback(() => {
    void refetchBoards();
  }, [refetchBoards]);

  return { status, unavailableReason, devices, start, reset, finish, rows, lookup, retryLookup };
}
