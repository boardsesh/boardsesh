import { beforeEach, describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => ({ request: vi.fn() }));
const auth = vi.hoisted(() => ({
  getAuthToken: vi.fn(async (): Promise<string | null> => null),
  recoverAuthRejection: vi.fn(async () => 'refreshed' as const),
}));
vi.mock('../../graphql/client', () => ({ getHttpClient: () => ({ request: http.request }) }));
vi.mock('../../auth-store', () => ({ getAuthToken: auth.getAuthToken }));
vi.mock('../../auth-interceptor', () => ({ recoverAuthRejection: auth.recoverAuthRejection }));

import { invalidateCredentialSnapshots } from '../../privacy/privacy-cache';
import { readSessionRestoreBoard } from '../session-restore-board';

const AUTH_REQUIRED = 'Authentication required to perform this operation';

/** graphql-request's ClientError shape for a 200 that carried errors. */
function answeredWithErrors(data: object | null, errors: object[]) {
  return Object.assign(new Error(AUTH_REQUIRED), { response: { status: 200, data, errors } });
}

/** What the server sends a request it reads as anonymous: the status, and a refused board. */
function anonymousBoardRefusal(sessionStatus: 'active' | null = 'active') {
  return answeredWithErrors({ sessionStatus, sessionRestoreBoardPath: null }, [
    { message: AUTH_REQUIRED, path: ['sessionRestoreBoardPath'] },
  ]);
}

describe('readSessionRestoreBoard', () => {
  beforeEach(() => {
    http.request.mockReset();
    auth.getAuthToken.mockReset().mockResolvedValue(null);
    auth.recoverAuthRejection.mockClear();
  });

  it('reads the access-checked board for a signed-in climber', async () => {
    http.request.mockResolvedValue({ sessionStatus: 'active', sessionRestoreBoardPath: 'kilter/1/10/1,2/40' });

    await expect(readSessionRestoreBoard('session-1')).resolves.toEqual({
      status: 'active',
      geometryPath: 'kilter/1/10/1,2/40',
      board: { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 },
      signedOut: false,
    });
  });

  it('keeps the public status when the server refuses the board to a signed-out phone', async () => {
    http.request.mockRejectedValue(anonymousBoardRefusal());

    await expect(readSessionRestoreBoard('session-1')).resolves.toEqual({
      status: 'active',
      geometryPath: null,
      board: null,
      signedOut: true,
    });
    expect(auth.recoverAuthRejection).not.toHaveBeenCalled();
  });

  it('passes on a signed-out answer that the session is gone', async () => {
    http.request.mockRejectedValue(anonymousBoardRefusal(null));

    await expect(readSessionRestoreBoard('session-1')).resolves.toMatchObject({ status: null, signedOut: true });
  });

  // An expired token reads as anonymous on the server, with a 200 and no 401,
  // so the interceptor never refreshes it. The phone is still signed in.
  it('leaves the board unverified and refreshes when the phone still holds a credential', async () => {
    auth.getAuthToken.mockResolvedValue('expired-jwt');
    const refusal = anonymousBoardRefusal();
    http.request.mockRejectedValue(refusal);

    await expect(readSessionRestoreBoard('session-1')).rejects.toBe(refusal);
    await vi.waitFor(() => expect(auth.recoverAuthRejection).toHaveBeenCalledTimes(1));
  });

  it('leaves the board unverified when the credential changed during the read', async () => {
    const refusal = anonymousBoardRefusal();
    http.request.mockImplementation(async () => {
      // A sign-out landed while the request was out.
      invalidateCredentialSnapshots();
      throw refusal;
    });

    await expect(readSessionRestoreBoard('session-1')).rejects.toBe(refusal);
    expect(auth.recoverAuthRejection).not.toHaveBeenCalled();
  });

  it('leaves the board unverified when the credential cannot be read', async () => {
    auth.getAuthToken.mockRejectedValue(new Error('Keychain locked'));
    const refusal = anonymousBoardRefusal();
    http.request.mockRejectedValue(refusal);

    await expect(readSessionRestoreBoard('session-1')).rejects.toBe(refusal);
  });

  it('still rejects any other failure of the board read', async () => {
    const masked = answeredWithErrors({ sessionStatus: 'active', sessionRestoreBoardPath: null }, [
      {
        message: 'Something went wrong on our end. Please try again.',
        path: ['sessionRestoreBoardPath'],
        extensions: { code: 'INTERNAL_SERVER_ERROR' },
      },
    ]);
    http.request.mockRejectedValue(masked);

    await expect(readSessionRestoreBoard('session-1')).rejects.toBe(masked);
  });

  it('still rejects when the status failed beside the refusal', async () => {
    const bothFailed = answeredWithErrors({ sessionStatus: null, sessionRestoreBoardPath: null }, [
      { message: 'Something went wrong on our end. Please try again.', path: ['sessionStatus'] },
      { message: AUTH_REQUIRED, path: ['sessionRestoreBoardPath'] },
    ]);
    http.request.mockRejectedValue(bothFailed);

    await expect(readSessionRestoreBoard('session-1')).rejects.toBe(bothFailed);
  });

  // A refused credential fails while the server builds the request context:
  // HTTP 401, no data, no field path (yoga-credential-errors.test.ts). The
  // interceptor hands that response on when its refresh is unavailable or
  // rejected. Nothing was answered, so there is no status to keep.
  it('still rejects the 401 a refused credential gets, which answers no status', async () => {
    auth.getAuthToken.mockResolvedValue(null);
    const refused = Object.assign(new Error('Authentication is required'), {
      response: {
        status: 401,
        errors: [{ message: 'Authentication is required', extensions: { code: 'UNAUTHENTICATED' } }],
      },
    });
    http.request.mockRejectedValue(refused);

    await expect(readSessionRestoreBoard('session-1')).rejects.toBe(refused);
    expect(auth.getAuthToken).not.toHaveBeenCalled();
  });

  it('still rejects a request that never reached the server', async () => {
    const offline = new TypeError('Network request failed');
    http.request.mockRejectedValue(offline);

    await expect(readSessionRestoreBoard('session-1')).rejects.toBe(offline);
  });
});
