import { parseBoardPath, toBoardName } from '@boardsesh/board-config';
import type { SessionStatus } from '@boardsesh/shared-schema';
import { getHttpClient } from '../graphql/client';
import { isExpectedAuthError } from '../graphql/extract-error-message';
import { SESSION_STATUS, type SessionStatusQueryResponse } from '../graphql/operations';

type BoardReadRefusal = {
  response?: {
    data?: { sessionStatus?: SessionStatus | null } | null;
    errors?: { path?: readonly (string | number)[] }[];
  };
};

/**
 * The lifecycle status is public, but `sessionRestoreBoardPath` needs an account.
 * A signed-out phone gets the status back beside one auth refusal on the board,
 * which graphql-request turns into a rejection. Returns that answered status, or
 * undefined for every other failure so it still reaches the caller.
 */
function readSignedOutStatus(error: unknown): SessionStatus | null | undefined {
  if (!isExpectedAuthError(error)) return undefined;
  const response = (error as BoardReadRefusal | null)?.response;
  const errors = response?.errors;
  if (errors?.length !== 1 || errors[0]?.path?.[0] !== 'sessionRestoreBoardPath') return undefined;
  return response?.data?.sessionStatus;
}

export async function readSessionRestoreBoard(sessionId: string) {
  let response: SessionStatusQueryResponse;
  try {
    response = await getHttpClient().request<SessionStatusQueryResponse>(SESSION_STATUS, { sessionId });
  } catch (error) {
    const status = readSignedOutStatus(error);
    if (status === undefined) throw error;
    // Signed out, there is no account board to verify. Callers join on this
    // phone's own board without the guard, as every join did before it.
    return { status, geometryPath: null, board: null, signedOut: true };
  }
  const parsed = response.sessionRestoreBoardPath ? parseBoardPath(response.sessionRestoreBoardPath) : null;
  return {
    status: response.sessionStatus,
    geometryPath: response.sessionRestoreBoardPath,
    board: parsed && toBoardName(parsed.boardName) ? parsed : null,
    signedOut: false,
  };
}
