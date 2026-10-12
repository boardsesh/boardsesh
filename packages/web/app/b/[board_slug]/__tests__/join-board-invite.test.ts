import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('server-only', () => ({}));
const redirect = vi.hoisted(() =>
  vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
);
const getServerAuthToken = vi.hoisted(() => vi.fn());
const redeemBoardInvite = vi.hoisted(() => vi.fn());
const resolveBoardBySlug = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ redirect }));
vi.mock('@/app/lib/auth/server-auth', () => ({ getServerAuthToken }));
vi.mock('@/app/lib/board-invite.server', () => ({ redeemBoardInvite }));
vi.mock('@/app/lib/board-slug-utils', () => ({ resolveBoardBySlug }));
vi.mock('@/app/lib/i18n/get-locale', () => ({ getLocale: async () => 'es' }));
const { joinBoardInvite } = await import('../join-board-invite');
const TOKEN = 'Ab3_dE-fGhIjKlMnOpQrSt';

beforeEach(() => {
  vi.clearAllMocks();
  getServerAuthToken.mockResolvedValue('session-token');
  redeemBoardInvite.mockResolvedValue({ boardUuid: 'friend-board', slug: 'renamed-garage' });
  resolveBoardBySlug.mockResolvedValue({ slug: 'renamed-garage', angle: 35 });
});

describe('explicit Join server action', () => {
  it('joins with the current session and drops the token from its locale-preserving redirect', async () => {
    await expect(joinBoardInvite(TOKEN)).rejects.toThrow('redirect:/es/b/renamed-garage/35/list');
    expect(redeemBoardInvite).toHaveBeenCalledWith(TOKEN, 'session-token');
    expect(resolveBoardBySlug).toHaveBeenCalledWith('renamed-garage');
    expect(redirect).toHaveBeenCalledWith('/es/b/renamed-garage/35/list');
  });
  it('writes nothing when the session expired before the button tap', async () => {
    getServerAuthToken.mockResolvedValue(undefined);
    await joinBoardInvite(TOKEN);
    expect(redeemBoardInvite).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });
  it('writes nothing for a malformed token', async () => {
    await joinBoardInvite('invalid');
    expect(redeemBoardInvite).not.toHaveBeenCalled();
  });
  it('keeps a refused link on the confirmation page', async () => {
    redeemBoardInvite.mockResolvedValue(null);
    await joinBoardInvite(TOKEN);
    expect(redirect).not.toHaveBeenCalled();
    expect(resolveBoardBySlug).not.toHaveBeenCalled();
  });
});
