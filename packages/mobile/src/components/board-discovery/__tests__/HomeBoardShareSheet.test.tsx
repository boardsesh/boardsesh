// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { createElement } from 'react';

type SheetProps = {
  shareUrl: string | null;
  visibility: string;
  subject?: string;
  linkFailed?: boolean;
  onResetLink?: () => void;
  resettingLink?: boolean;
  posterUrl?: string | null;
};
const captured = vi.hoisted(() => ({ props: undefined as SheetProps | undefined }));
const linkQuery = vi.hoisted(() => ({
  current: { data: undefined, isError: false } as { data?: { path: string } | null; isError: boolean },
}));
const linkEnabled = vi.hoisted(() => vi.fn());
const resetMutate = vi.hoisted(() => vi.fn());
const confirm = vi.hoisted(() => vi.fn());
const showToast = vi.hoisted(() => vi.fn());

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../BoardShareSheet', () => ({
  BoardShareSheet: (props: SheetProps) => {
    captured.props = props;
    return createElement('div', { 'data-testid': 'sheet' }, props.shareUrl ?? 'no-url');
  },
}));
vi.mock('../../../providers/dialog-provider', () => ({ useConfirm: () => confirm }));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast }) }));
vi.mock('../../../lib/env', () => ({ WEB_BASE_URL: 'https://www.boardsesh.com' }));
vi.mock('../../../lib/graphql/hooks/use-board-share-link', () => ({
  useBoardShareLink: (boardUuid: string, enabled: boolean) => {
    linkEnabled(boardUuid, enabled);
    return linkQuery.current;
  },
  useResetBoardShareLink: () => ({ mutate: resetMutate, isPending: false }),
}));

const { HomeBoardShareSheet } = await import('../HomeBoardShareSheet');

const PATH = '/b/the-garage?invite=Ab3_dE-fGhIjKlMnOpQrSt';

beforeEach(() => {
  vi.clearAllMocks();
  captured.props = undefined;
  linkQuery.current = { data: { path: PATH }, isError: false };
});

describe('HomeBoardShareSheet', () => {
  it("hands out a Public or Unlisted board's plain link without asking the server for one", () => {
    render(
      <HomeBoardShareSheet
        target={{
          kind: 'plain',
          url: 'https://www.boardsesh.com/b/the-garage',
          visibility: 'unlisted',
          posterUrl: 'https://www.boardsesh.com/poster/b/the-garage',
        }}
        boardName="Garage"
        onDismiss={vi.fn()}
      />,
    );
    expect(captured.props).toMatchObject({
      shareUrl: 'https://www.boardsesh.com/b/the-garage',
      visibility: 'unlisted',
      subject: 'board',
      posterUrl: 'https://www.boardsesh.com/poster/b/the-garage',
    });
    // A plain link grants nothing, so there is nothing to reset.
    expect(captured.props?.onResetLink).toBeUndefined();
    expect(linkEnabled).not.toHaveBeenCalled();
  });

  it("shares the owner's tokened link for a Followers or Invite-only board", () => {
    render(
      <HomeBoardShareSheet target={{ kind: 'invite', boardUuid: 'board-1' }} boardName="Garage" onDismiss={vi.fn()} />,
    );
    expect(linkEnabled).toHaveBeenCalledWith('board-1', true);
    expect(captured.props).toMatchObject({
      shareUrl: `https://www.boardsesh.com${PATH}`,
      visibility: 'invite',
      subject: 'board',
      linkFailed: false,
    });
    // An invite token taped to a wall stops being an invite: no poster.
    expect(captured.props?.posterUrl).toBeUndefined();
  });

  it('shows the failure when the board stopped being shareable', () => {
    linkQuery.current = { data: null, isError: false };
    render(
      <HomeBoardShareSheet target={{ kind: 'invite', boardUuid: 'board-1' }} boardName="Garage" onDismiss={vi.fn()} />,
    );
    expect(captured.props).toMatchObject({ shareUrl: null, linkFailed: true });
  });

  it('resets only after the owner confirms', async () => {
    render(
      <HomeBoardShareSheet target={{ kind: 'invite', boardUuid: 'board-1' }} boardName="Garage" onDismiss={vi.fn()} />,
    );

    confirm.mockResolvedValueOnce(false);
    await act(async () => captured.props?.onResetLink?.());
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'mobile.boardShare.resetConfirmTitle', destructive: true }),
    );
    expect(resetMutate).not.toHaveBeenCalled();

    confirm.mockResolvedValueOnce(true);
    await act(async () => captured.props?.onResetLink?.());
    expect(resetMutate).toHaveBeenCalledOnce();
    const [, callbacks] = resetMutate.mock.calls[0] as [unknown, { onSuccess: (link: unknown) => void }];
    callbacks.onSuccess({ path: '/b/the-garage?invite=NewToken_NewToken_1234' });
    expect(showToast).toHaveBeenCalledWith('mobile.boardShare.resetDone', 'success');
  });
});
