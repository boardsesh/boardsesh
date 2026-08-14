// Debounced lookup that powers the board form's inline serial-reuse warning:
// as the user types a serial, it checks whether a foreign (non-editable) board
// already claims it, so we can nudge them onto that wall before they submit.

import { useEffect, useMemo, useState } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';
import { useBoardsBySerialNumbers } from '../graphql/hooks';
import { boardConfigMatches, selectForeignSerialBoards, type SerialBoardConfig } from './serial-reuse';

const DEBOUNCE_MS = 400;
const MIN_SERIAL_LENGTH = 3;

/**
 * The first foreign board already registered to `serialNumber`, or `null` when
 * none match. Debounced (no per-keystroke query) and gated at 3 characters. The
 * board being edited (`currentBoardUuid`) is excluded so editing your own board
 * never warns about itself. When `config` is supplied only a SAME-CONFIG foreign
 * board triggers the warning — cross-model serial reuse (the LED supplier ships
 * one serial on e.g. a Kilter and a Tension) is legitimate and should not nag,
 * mirroring the backend's createBoard guard. React Query keys on the debounced
 * serial, so a stale in-flight response is ignored once the serial changes.
 */
export function useForeignSerialBoard(
  serialNumber: string,
  currentBoardUuid?: string | null,
  config?: SerialBoardConfig | null,
): UserBoard | null {
  const [debouncedSerial, setDebouncedSerial] = useState('');

  useEffect(() => {
    const trimmed = serialNumber.trim();
    if (trimmed.length < MIN_SERIAL_LENGTH) {
      setDebouncedSerial('');
      return;
    }
    const timer = setTimeout(() => setDebouncedSerial(trimmed), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [serialNumber]);

  const { data } = useBoardsBySerialNumbers(debouncedSerial ? [debouncedSerial] : []);

  return useMemo(() => {
    if (!data || data.length === 0) return null;
    const candidates = selectForeignSerialBoards(data, config ?? null, currentBoardUuid);
    if (!config) return candidates[0] ?? null;
    return candidates.find((board) => boardConfigMatches(board, config)) ?? null;
  }, [data, currentBoardUuid, config]);
}
