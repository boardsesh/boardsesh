import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { BoardShareSheet } from './BoardShareSheet';
import { useConfirm } from '../../providers/dialog-provider';
import { useToast } from '../../providers/toast-provider';
import { buildBoardShareUrl, type HomeBoardShareTarget } from '../../lib/board-share/board-share-link';
import { useBoardShareLink, useResetBoardShareLink } from '../../lib/graphql/hooks/use-board-share-link';

type HomeBoardShareSheetProps = {
  target: HomeBoardShareTarget;
  boardName: string;
  onDismiss: () => void;
};

/**
 * The Share sheet for a home board. A Public or Unlisted board hands out its
 * plain link; a Followers or Invite-only board hands out the owner's invite
 * link, which grants access after the recipient confirms Join (`board-share-link.ts`).
 */
export function HomeBoardShareSheet({ target, boardName, onDismiss }: HomeBoardShareSheetProps) {
  if (target.kind === 'plain') {
    return (
      <BoardShareSheet
        visible
        onDismiss={onDismiss}
        shareUrl={target.url}
        wallName={boardName}
        visibility={target.visibility}
        subject="board"
      />
    );
  }
  return <InviteLinkShareSheet boardUuid={target.boardUuid} boardName={boardName} onDismiss={onDismiss} />;
}

function InviteLinkShareSheet({
  boardUuid,
  boardName,
  onDismiss,
}: {
  boardUuid: string;
  boardName: string;
  onDismiss: () => void;
}) {
  const { t } = useTranslation('boards');
  const confirm = useConfirm();
  const { showToast } = useToast();
  // Minted on this first read, while the sheet is open: browsing boards never
  // creates a link nobody asked for.
  const link = useBoardShareLink(boardUuid, true);
  const reset = useResetBoardShareLink(boardUuid);
  const shareUrl = link.data ? buildBoardShareUrl(link.data.path) : null;
  // `null` from the server means the board stopped being shareable (made Public,
  // Unlisted or Only me elsewhere) while this sheet was opening.
  const linkFailed = link.isError || link.data === null;

  const { mutate: resetLink } = reset;
  const handleResetLink = useCallback(() => {
    void (async () => {
      const confirmed = await confirm({
        title: t('mobile.boardShare.resetConfirmTitle'),
        message: t('mobile.boardShare.resetConfirmBody'),
        confirmLabel: t('mobile.boardShare.resetConfirm'),
        cancelLabel: t('mobile.boardShare.resetCancel'),
        destructive: true,
      });
      if (!confirmed) return;
      resetLink(undefined, {
        onSuccess: (fresh) => {
          if (fresh) showToast(t('mobile.boardShare.resetDone'), 'success');
          else showToast(t('mobile.boardShare.resetFailed'), 'error');
        },
        onError: () => showToast(t('mobile.boardShare.resetFailed'), 'error'),
      });
    })();
  }, [confirm, resetLink, showToast, t]);

  return (
    <BoardShareSheet
      visible
      onDismiss={onDismiss}
      shareUrl={shareUrl}
      wallName={boardName}
      visibility="invite"
      subject="board"
      linkFailed={linkFailed}
      onResetLink={handleResetLink}
      resettingLink={reset.isPending}
    />
  );
}
