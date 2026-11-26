import { parseBoardPath, toBoardName } from '@boardsesh/board-config';
import { getHttpClient } from '../graphql/client';
import { SESSION_STATUS, type SessionStatusQueryResponse } from '../graphql/operations';

export async function readSessionRestoreBoard(sessionId: string) {
  const response = await getHttpClient().request<SessionStatusQueryResponse>(SESSION_STATUS, { sessionId });
  const parsed = response.sessionRestoreBoardPath ? parseBoardPath(response.sessionRestoreBoardPath) : null;
  return {
    status: response.sessionStatus,
    board: parsed && toBoardName(parsed.boardName) ? parsed : null,
  };
}
