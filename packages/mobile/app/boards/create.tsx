import { useCallback, useMemo, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { toBoardName } from '@boardsesh/board-config';
import { useMyBoards, useCreateBoard, useProfile } from '../../src/lib/graphql/hooks';
import { useSetActiveBoard } from '../../src/lib/graphql/use-active-board';
import { useAuth } from '../../src/providers/auth-provider';
import { useToast } from '../../src/providers/toast-provider';
import { hapticSelection } from '../../src/lib/haptics';
import { resolveBoardReturnTo } from '../../src/lib/boards/board-return-to';
import { useBoardBuilder, type BoardBuilderSeed } from '../../src/components/board-discovery/use-board-builder';
import { BoardForm } from '../../src/components/board-discovery/BoardForm';
import { formatDefaultBoardName } from '../../src/components/board-discovery/board-builder-labels';
import { findOwnedBoardForConfig } from '../../src/components/board-discovery/board-items';

export default function CreateBoard() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    returnTo?: string;
    seedBoardName?: string;
    seedLayoutId?: string;
    seedSizeId?: string;
    seedSetIds?: string;
  }>();
  const boardReturnTo = resolveBoardReturnTo(params.returnTo);
  const { isAuthenticated } = useAuth();
  const { t } = useTranslation('boards');
  const { showToast } = useToast();

  const setActiveBoard = useSetActiveBoard();
  const createBoard = useCreateBoard();
  const { data: profile } = useProfile({ enabled: isAuthenticated });
  const { data: boardConnection } = useMyBoards(undefined, { enabled: isAuthenticated });
  const myBoards = boardConnection?.boards ?? [];

  // Pre-fill when opened from a Popular config. Memoised so the builder doesn't
  // re-seed (and wipe edits) on every render.
  const seed = useMemo<BoardBuilderSeed | null>(() => {
    const boardName = params.seedBoardName ? toBoardName(params.seedBoardName) : null;
    if (!boardName || !params.seedLayoutId || !params.seedSizeId || !params.seedSetIds) return null;
    return {
      boardName,
      layoutId: Number(params.seedLayoutId),
      sizeId: Number(params.seedSizeId),
      setIds: params.seedSetIds,
    };
  }, [params.seedBoardName, params.seedLayoutId, params.seedSizeId, params.seedSetIds]);

  const builder = useBoardBuilder(seed);

  // Auto-generated default name, e.g. "Marco's Kilter Original 12×12", from the
  // user's display name + config. Used as the placeholder and the create-time
  // fallback when the user leaves the name blank.
  const selectedSize = useMemo(
    () => builder.sizes.find((size) => size.id === builder.sizeId) ?? null,
    [builder.sizes, builder.sizeId],
  );
  const defaultName = useMemo(
    () =>
      formatDefaultBoardName({
        userName: profile?.displayName,
        boardName: builder.boardName,
        layoutName: builder.rawLayoutName,
        size: selectedSize,
      }),
    [profile?.displayName, builder.boardName, builder.rawLayoutName, selectedSize],
  );

  const [submitting, setSubmitting] = useState(false);

  const handleCreate = useCallback(async () => {
    if (submitting) return;
    const input = builder.buildCreateInput(defaultName);
    if (!input) return;
    setSubmitting(true);
    hapticSelection();
    try {
      // Activate an already-owned matching board instead of hitting the server's
      // duplicate-config guard.
      const owned = findOwnedBoardForConfig(myBoards, {
        boardType: input.boardType,
        layoutId: input.layoutId,
        sizeId: input.sizeId,
        setIds: input.setIds,
      });
      const board = owned ?? (await createBoard.mutateAsync(input));
      await setActiveBoard(board);
      router.dismissTo(boardReturnTo);
      // Navigated away on success — no need to clear `submitting` (unmounting).
    } catch {
      showToast(t('mobile.create.createError'), 'error');
      setSubmitting(false);
    }
  }, [submitting, builder, defaultName, myBoards, createBoard, setActiveBoard, router, boardReturnTo, showToast, t]);

  return (
    <BoardForm
      builder={builder}
      defaultName={defaultName}
      submitting={submitting}
      onSubmit={() => void handleCreate()}
      submitLabel={t('mobile.create.save')}
    />
  );
}
