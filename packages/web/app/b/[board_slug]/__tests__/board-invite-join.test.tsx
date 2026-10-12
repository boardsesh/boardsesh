// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';

const joinBoardInvite = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/app/components/i18n/locale-link', () => ({
  default: ({ href, children }: { href: string; children: unknown }) =>
    createElement('a', { href }, children as import('react').ReactNode),
}));
vi.mock('../join-board-invite', () => ({ joinBoardInvite }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const { default: BoardInviteJoin } = await import('../board-invite-join');
const TOKEN = 'Ab3_dE-fGhIjKlMnOpQrSt';
beforeEach(() => {
  joinBoardInvite.mockReset().mockResolvedValue(undefined);
});

describe('board invite Join confirmation', () => {
  it('does not grant access on render; a deliberate Join tap grants once', async () => {
    render(createElement(BoardInviteJoin, { boardName: 'Friends Garage', inviteToken: TOKEN }));
    expect(joinBoardInvite).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'boardShareLink.join' }));
    await waitFor(() => expect(joinBoardInvite).toHaveBeenCalledOnce());
    expect(joinBoardInvite).toHaveBeenCalledWith(TOKEN);
  });
  it('shows a retry error without reporting a token-bearing rejection', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    joinBoardInvite.mockRejectedValue(new Error(`request failed: ${TOKEN}`));
    render(createElement(BoardInviteJoin, { boardName: 'Friends Garage', inviteToken: TOKEN }));
    fireEvent.click(screen.getByRole('button', { name: 'boardShareLink.join' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('boardShareLink.joinFailed'));
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
  it('treats the redirect a successful Join ends in as success, not a failure', async () => {
    // Next rejects the action call with its redirect once the router has
    // started navigating to the board.
    joinBoardInvite.mockRejectedValue(
      Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;push;/b/friends-garage/40/list;303;' }),
    );
    render(createElement(BoardInviteJoin, { boardName: 'Friends Garage', inviteToken: TOKEN }));
    const join = screen.getByRole('button', { name: 'boardShareLink.join' });
    fireEvent.click(join);
    await waitFor(() => expect(joinBoardInvite).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole('alert')).toBeNull();
    // Join stays disabled while the board page loads.
    expect((join as HTMLButtonElement).disabled).toBe(true);
  });
});
