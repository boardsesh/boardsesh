import type { UserBoard } from '@boardsesh/shared-schema';
import { getHttpClient } from '../client';
// Mobile's own GetBoard, not the shared one of the same name: the shared
// document selects neither `timerName` nor `isPinnedByMe`, and a board healed
// through here replaces the active board the paired timer and pin controls read.
import { GET_BOARD, type GetBoardQueryResponse } from '../operations';

/** Fetch current board details even when a picker or stored active board is stale. */
export async function fetchBoardByUuid(boardUuid: string): Promise<UserBoard | null> {
  const response = await getHttpClient().request<GetBoardQueryResponse>(GET_BOARD, { boardUuid });
  return response.board;
}
