import {
  GET_BOARDS_BY_SERIAL_NUMBERS,
  GET_OBSERVED_BOARD_SERIAL_MATCHES,
  type GetBoardsBySerialNumbersQueryResponse,
  type GetObservedBoardSerialMatchesQueryResponse,
} from '@boardsesh/graphql/operations';
import type { UserBoard } from '@boardsesh/shared-schema';
import { getHttpClient } from '../graphql/client';
import { matchesAdvertisedType, type AdvertisedBoardTypes } from './advertised-board-type';

/** Correlate only serials the caller heard, without relying on owner-only fields. */
export async function fetchBoardsForObservedSerials(
  serialNumbers: string[],
  advertisedTypes: AdvertisedBoardTypes,
): Promise<UserBoard[]> {
  const uniqueSerials = [...new Set(serialNumbers.filter((serial) => serial.trim().length > 0))].slice(0, 20);
  const observedInput = uniqueSerials.flatMap((observedSerialNumber) => {
    const boardType = advertisedTypes.get(observedSerialNumber);
    return boardType ? [{ boardType, observedSerialNumber }] : [];
  });
  const untypedSerials = uniqueSerials.filter((serial) => !advertisedTypes.has(serial));
  const client = getHttpClient();
  const [observedResult, untypedResult] = await Promise.all([
    observedInput.length > 0
      ? client.request<GetObservedBoardSerialMatchesQueryResponse>(GET_OBSERVED_BOARD_SERIAL_MATCHES, {
          input: observedInput,
        })
      : Promise.resolve({ observedBoardSerialMatches: [] }),
    untypedSerials.length > 0
      ? client.request<GetBoardsBySerialNumbersQueryResponse>(GET_BOARDS_BY_SERIAL_NUMBERS, {
          serialNumbers: untypedSerials,
        })
      : Promise.resolve({ boardsBySerialNumbers: [] }),
  ]);
  const observedBoards = observedResult.observedBoardSerialMatches.flatMap((match) => {
    const observation = observedInput.find(
      (input) =>
        input.boardType === match.boardType &&
        input.observedSerialNumber.trim().toUpperCase() === match.observedSerialNumber,
    );
    if (!observation) return [];
    return match.candidates
      .filter((board) => board.boardType === observation.boardType)
      .map((board) => ({
        ...board,
        // This is the caller's BLE observation, never a disclosed stored serial.
        serialNumber: observation.observedSerialNumber,
      }));
  });
  return [...observedBoards, ...untypedResult.boardsBySerialNumbers].filter(
    (board) => !board.serialNumber || matchesAdvertisedType(board.serialNumber, board.boardType, advertisedTypes),
  );
}
