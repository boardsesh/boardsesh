import {
  GET_BOARDS_BY_SERIAL_NUMBERS,
  GET_OBSERVED_BOARD_SERIAL_MATCHES,
  GET_OBSERVED_BOARD_SERIAL_MATCHES_WITH_REQUEST_CARDS,
  type GetBoardsBySerialNumbersQueryResponse,
  type GetObservedBoardSerialMatchesQueryResponse,
  type GetObservedBoardSerialMatchesWithRequestCardsQueryResponse,
} from '@boardsesh/graphql/operations';
import type { SerialBoardRequestCard } from '@boardsesh/shared-schema';
import { getHttpClient } from '../graphql/client';
import type { ObservedBoard } from '../boards/in-range-request-card';
import { matchesAdvertisedType, type AdvertisedBoardTypes } from './advertised-board-type';

/**
 * Correlate only serials the caller heard, without relying on owner-only fields.
 * `requestCards`: also ask for request cards, which spend the climber's hourly
 * budget (10 boards). Only the picker's In range slot, which draws them, asks.
 */
export async function fetchBoardsForObservedSerials(
  serialNumbers: string[],
  advertisedTypes: AdvertisedBoardTypes,
  { requestCards = false }: { requestCards?: boolean } = {},
): Promise<ObservedBoard[]> {
  const uniqueSerials = [...new Set(serialNumbers.filter((serial) => serial.trim().length > 0))].slice(0, 20);
  const observedInput = uniqueSerials.flatMap((observedSerialNumber) => {
    const boardType = advertisedTypes.get(observedSerialNumber);
    return boardType ? [{ boardType, observedSerialNumber }] : [];
  });
  const untypedSerials = uniqueSerials.filter((serial) => !advertisedTypes.has(serial));
  const client = getHttpClient();
  const [observedResult, untypedResult] = await Promise.all([
    observedInput.length > 0
      ? client.request<
          GetObservedBoardSerialMatchesQueryResponse | GetObservedBoardSerialMatchesWithRequestCardsQueryResponse
        >(requestCards ? GET_OBSERVED_BOARD_SERIAL_MATCHES_WITH_REQUEST_CARDS : GET_OBSERVED_BOARD_SERIAL_MATCHES, {
          input: observedInput,
        })
      : Promise.resolve({ observedBoardSerialMatches: [] }),
    untypedSerials.length > 0
      ? client.request<GetBoardsBySerialNumbersQueryResponse>(GET_BOARDS_BY_SERIAL_NUMBERS, {
          serialNumbers: untypedSerials,
        })
      : Promise.resolve({ boardsBySerialNumbers: [] }),
  ]);
  const matches: ReadonlyArray<
    GetObservedBoardSerialMatchesQueryResponse['observedBoardSerialMatches'][number] & {
      candidateRequestCards?: ReadonlyArray<SerialBoardRequestCard | null>;
    }
  > = observedResult.observedBoardSerialMatches;
  const observedBoards = matches.flatMap((match) => {
    const observation = observedInput.find(
      (input) =>
        input.boardType === match.boardType &&
        input.observedSerialNumber.trim().toUpperCase() === match.observedSerialNumber,
    );
    if (!observation) return [];
    return match.candidates.flatMap((board, index): ObservedBoard[] => {
      if (board.boardType !== observation.boardType) return [];
      // Lined up with `candidates`; absent when the lookup didn't ask for cards.
      const requestCard = requestCards ? (match.candidateRequestCards?.[index] ?? null) : null;
      // A card only ever stands for a stub: a board the climber can open is
      // drawn as itself, never as a request.
      const carriesCard = requestCard !== null && !board.uuid && requestCard.preview.boardType === board.boardType;
      return [
        {
          ...board,
          // This is the caller's BLE observation, never a disclosed stored serial.
          serialNumber: observation.observedSerialNumber,
          ...(carriesCard ? { requestCard } : {}),
        },
      ];
    });
  });
  return [...observedBoards, ...untypedResult.boardsBySerialNumbers].filter(
    (board) => !board.serialNumber || matchesAdvertisedType(board.serialNumber, board.boardType, advertisedTypes),
  );
}
