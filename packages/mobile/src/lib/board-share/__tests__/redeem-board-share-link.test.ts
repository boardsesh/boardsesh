import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';

const request = vi.hoisted(() => vi.fn());
const fetchBoardByUuid = vi.hoisted(() => vi.fn());
const confirmJoin = vi.hoisted(() => vi.fn(async (_boardName: string) => true));
const credential = vi.hoisted(() => ({ current: true }));

vi.mock('../../graphql/client', () => ({ getHttpClient: () => ({ request }) }));
vi.mock('../../graphql/hooks/fetch-board-by-uuid', () => ({ fetchBoardByUuid }));
vi.mock('../../auth-store', () => ({
  captureAuthCredentialGeneration: () => 7,
  isAuthCredentialGenerationCurrent: () => credential.current,
}));

const { fetchBoardFromShareLink } = await import('../redeem-board-share-link');

const TOKEN = 'Ab3_dE-fGhIjKlMnOpQrSt';
const MEMBER_BOARD = { uuid: 'board-uuid', slug: 'renamed-garage' } as unknown as UserBoard;
const PLAIN_BOARD = { uuid: 'plain', slug: 'the-garage' } as unknown as UserBoard;

beforeEach(() => {
  request.mockReset().mockResolvedValueOnce({ boardShareLinkPreview: { name: 'Friends Garage' } });
  confirmJoin.mockReset().mockResolvedValue(true);
  fetchBoardByUuid.mockReset().mockResolvedValue(MEMBER_BOARD);
  credential.current = true;
});

describe('fetchBoardFromShareLink', () => {
  it('joins, then reads the board the server redeemed, whatever slug the URL carried', async () => {
    request.mockResolvedValue({ redeemBoardShareLink: { boardUuid: 'board-uuid', slug: 'renamed-garage' } });
    const fallback = vi.fn(async () => PLAIN_BOARD);

    await expect(fetchBoardFromShareLink(TOKEN, 'the-garage', fallback, confirmJoin)).resolves.toBe(MEMBER_BOARD);
    expect(request).toHaveBeenCalledTimes(2);
    expect(confirmJoin).toHaveBeenCalledWith('Friends Garage');
    expect(request).toHaveBeenCalledWith(expect.anything(), { token: TOKEN });
    expect(fetchBoardByUuid).toHaveBeenCalledWith('board-uuid');
    expect(fallback).not.toHaveBeenCalled();
  });

  it('opens the link as a plain board link when the server refuses it, and reports nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    request.mockRejectedValue(Object.assign(new Error('Not found'), { request: { variables: { token: TOKEN } } }));
    const fallback = vi.fn(async () => PLAIN_BOARD);

    await expect(fetchBoardFromShareLink(TOKEN, 'the-garage', fallback, confirmJoin)).resolves.toBe(PLAIN_BOARD);
    expect(fallback).toHaveBeenCalledWith('the-garage');
    expect(fetchBoardByUuid).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
  });

  it('tries once more after a refusal that is not final, then joins', async () => {
    vi.useFakeTimers();
    try {
      request
        .mockRejectedValueOnce({ response: { errors: [{ message: 'busy', extensions: { code: 'RATE_LIMITED' } }] } })
        .mockResolvedValueOnce({ redeemBoardShareLink: { boardUuid: 'board-uuid', slug: 'renamed-garage' } });
      const fallback = vi.fn(async () => PLAIN_BOARD);
      const pending = fetchBoardFromShareLink(TOKEN, 'the-garage', fallback, confirmJoin);
      await vi.advanceTimersByTimeAsync(2000);
      await expect(pending).resolves.toBe(MEMBER_BOARD);
      expect(request).toHaveBeenCalledTimes(3);
      expect(fallback).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('takes NOT_FOUND as final: no retry, straight to the plain link', async () => {
    request.mockRejectedValue({ response: { errors: [{ message: 'Not found', extensions: { code: 'NOT_FOUND' } }] } });
    const fallback = vi.fn(async () => PLAIN_BOARD);
    await expect(fetchBoardFromShareLink(TOKEN, 'the-garage', fallback, confirmJoin)).resolves.toBe(PLAIN_BOARD);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('makes no grant request until the climber confirms, and cancel writes nothing', async () => {
    let answer: ((confirmed: boolean) => void) | undefined;
    confirmJoin.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    const fallback = vi.fn(async () => PLAIN_BOARD);
    const pending = fetchBoardFromShareLink(TOKEN, 'the-garage', fallback, confirmJoin);
    await vi.waitFor(() => expect(confirmJoin).toHaveBeenCalled());
    expect(request).toHaveBeenCalledTimes(1);
    answer!(false);
    await expect(pending).resolves.toBe(PLAIN_BOARD);
    expect(request).toHaveBeenCalledTimes(1);
    expect(fetchBoardByUuid).not.toHaveBeenCalled();
  });

  it('does not join when accounts switch while the confirm is open', async () => {
    confirmJoin.mockImplementationOnce(async () => {
      credential.current = false;
      return true;
    });
    const fallback = vi.fn(async () => PLAIN_BOARD);
    await expect(fetchBoardFromShareLink(TOKEN, 'the-garage', fallback, confirmJoin)).resolves.toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('does not join after the route was abandoned while the confirm was open', async () => {
    let routeIsCurrent = true;
    confirmJoin.mockImplementationOnce(async () => {
      routeIsCurrent = false;
      return true;
    });
    const fallback = vi.fn(async () => PLAIN_BOARD);
    await expect(
      fetchBoardFromShareLink(TOKEN, 'the-garage', fallback, confirmJoin, () => routeIsCurrent),
    ).resolves.toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('refuses stale adoption if the account changes during the board fetch', async () => {
    request.mockResolvedValue({ redeemBoardShareLink: { boardUuid: 'board-uuid', slug: 'renamed-garage' } });
    fetchBoardByUuid.mockImplementationOnce(async () => {
      credential.current = false;
      return MEMBER_BOARD;
    });
    const fallback = vi.fn(async () => PLAIN_BOARD);
    await expect(fetchBoardFromShareLink(TOKEN, 'the-garage', fallback, confirmJoin)).resolves.toBeNull();
    expect(fetchBoardByUuid).toHaveBeenCalled();
  });

  it('adopts nothing when the account changed while the request was out', async () => {
    request.mockResolvedValue({ redeemBoardShareLink: { boardUuid: 'board-uuid', slug: 'renamed-garage' } });
    credential.current = false;
    const fallback = vi.fn(async () => PLAIN_BOARD);

    await expect(fetchBoardFromShareLink(TOKEN, 'the-garage', fallback, confirmJoin)).resolves.toBeNull();
    expect(fetchBoardByUuid).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });
});
