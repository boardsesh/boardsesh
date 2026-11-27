import { beforeEach, describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../graphql/client', () => ({ getHttpClient: () => ({ request: http.request }) }));

import { readSessionRestoreBoard } from '../session-restore-board';

const AUTH_REQUIRED = 'Authentication required to perform this operation';

/** graphql-request's ClientError shape for a 200 that carried errors. */
function answeredWithErrors(data: object | null, errors: object[]) {
  return Object.assign(new Error(AUTH_REQUIRED), { response: { status: 200, data, errors } });
}

describe('readSessionRestoreBoard', () => {
  beforeEach(() => {
    http.request.mockReset();
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
    http.request.mockRejectedValue(
      answeredWithErrors({ sessionStatus: 'active', sessionRestoreBoardPath: null }, [
        { message: AUTH_REQUIRED, path: ['sessionRestoreBoardPath'] },
      ]),
    );

    await expect(readSessionRestoreBoard('session-1')).resolves.toEqual({
      status: 'active',
      geometryPath: null,
      board: null,
      signedOut: true,
    });
  });

  it('passes on a signed-out answer that the session is gone', async () => {
    http.request.mockRejectedValue(
      answeredWithErrors({ sessionStatus: null, sessionRestoreBoardPath: null }, [
        { message: AUTH_REQUIRED, path: ['sessionRestoreBoardPath'] },
      ]),
    );

    await expect(readSessionRestoreBoard('session-1')).resolves.toMatchObject({ status: null, signedOut: true });
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

  it('still rejects a refused credential, which is not a signed-out answer', async () => {
    const refused = answeredWithErrors(null, [
      { message: 'Authentication is required', extensions: { code: 'UNAUTHENTICATED' } },
    ]);
    http.request.mockRejectedValue(refused);

    await expect(readSessionRestoreBoard('session-1')).rejects.toBe(refused);
  });

  it('still rejects a request that never reached the server', async () => {
    const offline = new TypeError('Network request failed');
    http.request.mockRejectedValue(offline);

    await expect(readSessionRestoreBoard('session-1')).rejects.toBe(offline);
  });
});
