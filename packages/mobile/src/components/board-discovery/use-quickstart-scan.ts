// The in-range scan, its serial lookup and the rows they make, for the board
// picker's in-range slot (use-picker-board-scan.ts). The rules live in the pure
// builders (quickstart-scan-rows.ts); this only wires the scan and the queries
// to them, and the slot only renders `rows`.

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';
import { useBoardScan, type BoardScan } from '../../lib/ble/use-board-scan';
import { useBoardsBySerialNumbers } from '../../lib/graphql/hooks';
import { selectBleBoardCandidates } from '../../lib/ble/select-board-candidates';
import { useMyBoardSerialConfigs } from '../../lib/ble/use-my-board-serial-configs';
import { useRecognizedBoardDevices } from '../../lib/ble/recognized-board-devices-store';
import {
  buildQuickstartRows,
  carryDrawnAnswer,
  quickstartLookupState,
  type QuickstartLookupState,
  type QuickstartRecognition,
  type QuickstartRow,
  type QuickstartSerialAnswer,
} from './quickstart-scan-rows';

const EMPTY_BOARDS: UserBoard[] = [];

export type QuickstartScan = Pick<
  BoardScan,
  'status' | 'unavailableReason' | 'devices' | 'start' | 'reset' | 'finish'
> & {
  /** Every board heard, as rows to list, strongest signal first. */
  rows: QuickstartRow[];
  /**
   * Where the serial lookup stands: `pending` while the scan's first answer is
   * out, `updating` while an answer already drawn waits on a serial heard since.
   */
  lookup: QuickstartLookupState;
  /** Run the serial lookup again, for the "need signal" row. */
  retryLookup: () => void;
};

export function useQuickstartScan({
  mayStartRadio,
  knownBoards,
}: {
  /** Asked right before the radio starts; false drops the start (see `useBoardScan`). */
  mayStartRadio?: () => boolean;
  /**
   * The climber's own and followed boards, which a serial-less box this phone
   * recognises by its Bluetooth id may be named as. Absent: no box is
   * recognised.
   */
  knownBoards?: readonly UserBoard[];
} = {}): QuickstartScan {
  const { status, unavailableReason, serials, advertisedTypes, devices, start, reset, finish } = useBoardScan({
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
  const lookupForSerialsHeard = quickstartLookupState({
    serialCount: serials.length,
    hasResult: boards !== undefined,
    failed: boardLookup.isError || boardLookup.fetchStatus === 'paused',
    resolving: isResolvingBoards || isResolvingPreferences,
  });
  const answerForSerialsHeard = useMemo<QuickstartSerialAnswer | null>(
    () => (lookupForSerialsHeard === 'resolved' ? { serials, boards: visibleBoards } : null),
    [lookupForSerialsHeard, serials, visibleBoards],
  );
  // Both queries are keyed on every serial heard, so each new serial starts
  // them over with no answer (no `placeholderData`: a kept answer would call a
  // serial it was never asked about unknown). The last answer drawn is kept
  // here instead, and `carryDrawnAnswer` keeps it up only for the serials it
  // answered, and only within the scan that heard them. Stored once a render
  // commits, so a render React throws away stores nothing, and dropped when a
  // scan starts over with no serials.
  const drawnAnswerRef = useRef<QuickstartSerialAnswer | null>(null);
  useEffect(() => {
    if (serials.length === 0) drawnAnswerRef.current = null;
    else if (answerForSerialsHeard) drawnAnswerRef.current = answerForSerialsHeard;
  }, [serials, answerForSerialsHeard]);
  const { lookup, answer } = carryDrawnAnswer({
    lookup: lookupForSerialsHeard,
    serials,
    drawn: answerForSerialsHeard ?? drawnAnswerRef.current,
  });
  const recognizedDevices = useRecognizedBoardDevices(knownBoards !== undefined);
  const recognition = useMemo<QuickstartRecognition | undefined>(
    () => (knownBoards ? { devices: recognizedDevices, knownBoards } : undefined),
    [knownBoards, recognizedDevices],
  );
  const rows = useMemo(
    () =>
      buildQuickstartRows({
        devices,
        boards: answer?.boards ?? EMPTY_BOARDS,
        answeredSerials: answer?.serials,
        lookup,
        recognition,
      }),
    [devices, answer, lookup, recognition],
  );
  const retryLookup = useCallback(() => {
    void refetchBoards();
  }, [refetchBoards]);

  return { status, unavailableReason, devices, start, reset, finish, rows, lookup, retryLookup };
}
