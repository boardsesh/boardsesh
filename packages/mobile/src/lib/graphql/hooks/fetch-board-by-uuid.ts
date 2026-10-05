import type { UserBoard } from '@boardsesh/shared-schema';
import { GET_BOARD, type GetBoardQueryResponse } from '@boardsesh/graphql/operations/boards';
import { getHttpClient } from '../client';

/** Fetch current board details even when a picker or stored active board is stale. */
export async function fetchBoardByUuid(boardUuid: string): Promise<UserBoard | null> {
  const response = await getHttpClient().request<GetBoardQueryResponse>(GET_BOARD, { boardUuid });
  return response.board;
}
