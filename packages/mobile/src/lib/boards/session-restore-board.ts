import { parseBoardPath, toBoardName } from '@boardsesh/board-config';
import type { SessionStatus } from '@boardsesh/shared-schema';
import { getHttpClient } from '../graphql/client';
import { isExpectedAuthError } from '../graphql/extract-error-message';
import { SESSION_STATUS, type SessionStatusQueryResponse } from '../graphql/operations';
import { getCredentialGeneration } from '../privacy/privacy-cache';

type BoardReadRefusal = {
  response?: {
    data?: { sessionStatus?: SessionStatus | null } | null;
    errors?: { path?: readonly (string | number)[] }[];
  };
};

/**
 * The lifecycle status is public, but `sessionRestoreBoardPath` needs an account.
 * A request the server reads as anonymous gets the status back beside one auth
 * refusal on the board, which graphql-request turns into a rejection. Returns
 * that answered status, or undefined for every other failure.
 */
function readAnonymousStatus(error: unknown): SessionStatus | null | undefined {
  if (!isExpectedAuthError(error)) return undefined;
  const response = (error as BoardReadRefusal | null)?.response;
  const errors = response?.errors;
  if (errors?.length !== 1 || errors[0]?.path?.[0] !== 'sessionRestoreBoardPath') return undefined;
  return response?.data?.sessionStatus;
}

/**
 * What this phone holds, read in the credential generation the request went
 * out under. Loaded only after a refusal, so the credential store stays out of
 * the queue's module graph.
 */
async function readHeldCredential(requestGeneration: number): Promise<'none' | 'held' | 'unknown'> {
  try {
    const { getAuthToken } = await import('../auth-store');
    const token = await getAuthToken();
    if (requestGeneration !== getCredentialGeneration()) return 'unknown';
    return token ? 'held' : 'none';
  } catch {
    return 'unknown';
  }
}

export async function readSessionRestoreBoard(sessionId: string) {
  const requestGeneration = getCredentialGeneration();
  let response: SessionStatusQueryResponse;
  try {
    response = await getHttpClient().request<SessionStatusQueryResponse>(SESSION_STATUS, { sessionId });
  } catch (error) {
    const status = readAnonymousStatus(error);
    if (status === undefined) throw error;
    const credential = await readHeldCredential(requestGeneration);
    if (credential !== 'none') {
      // The server reads an expired token as anonymous, but this phone is
      // signed in: its board stays unverified. A refresh lets a retry prove it.
      if (credential === 'held') {
        void import('../auth-interceptor')
          .then(({ recoverAuthRejection }) => recoverAuthRejection())
          .catch(() => undefined);
      }
      throw error;
    }
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
