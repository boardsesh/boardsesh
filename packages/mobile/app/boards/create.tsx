import { useCallback, useMemo, useRef, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { toBoardName } from '@boardsesh/board-config';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import type { CreateBoardInput, UserBoard } from '@boardsesh/shared-schema';
import { useCreateBoard, useProfile, fetchBoardByUuid } from '../../src/lib/graphql/hooks';
import { useSetActiveBoard } from '../../src/lib/graphql/use-active-board';
import {
  extractGraphqlMessage,
  isGraphqlRateLimitedError,
  isExpectedAuthError,
  readDuplicateBoardError,
  type DuplicateBoardError,
} from '../../src/lib/graphql/extract-error-message';
import { track } from '../../src/lib/analytics';
import { useAuth } from '../../src/providers/auth-provider';
import { hapticSelection } from '../../src/lib/haptics';
import { resolveBoardReturnTo } from '../../src/lib/boards/board-return-to';
import { useBoardBuilder, type BoardBuilderSeed } from '../../src/components/board-discovery/use-board-builder';
import { BoardForm } from '../../src/components/board-discovery/BoardForm';
import { BoardDuplicatePromptSheet } from '../../src/components/board-discovery/BoardDuplicatePromptSheet';
import { formatDefaultBoardName } from '../../src/components/board-discovery/board-builder-labels';

/** Analytics properties describing a create attempt. Never carries free text or coordinates. */
function describeInput(input: CreateBoardInput, source: 'popular_seed' | 'scratch') {
  return {
    boardType: input.boardType,
    layoutId: input.layoutId,
    sizeId: input.sizeId,
    setCount: input.setIds.split(',').filter(Boolean).length,
    angle: input.angle,
    isOwned: input.isOwned,
    isPublic: input.isPublic,
    hasLocationName: !!input.locationName,
    hasCoords: input.latitude != null && input.longitude != null,
    hasGym: !!input.gymUuid,
    source,
  };
}

function classifyCreateFailure(error: unknown): 'rate_limited' | 'auth' | 'exception' {
  if (isGraphqlRateLimitedError(error)) return 'rate_limited';
  if (isExpectedAuthError(error)) return 'auth';
  return 'exception';
}

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

  const setActiveBoard = useSetActiveBoard();
  const createBoard = useCreateBoard();
  const { data: profile } = useProfile({ enabled: isAuthenticated });

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

  const source = seed ? 'popular_seed' : 'scratch';
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
  const [createError, setCreateError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<DuplicateBoardError | null>(null);
  // `submitting` is only accurate on the NEXT render, so it can't guard a call
  // that fires in the same tick as the state update — which is exactly what
  // "add a new board here" does (dismiss the sheet, then create). This ref is
  // set synchronously and is the real in-flight lock.
  const inFlightRef = useRef(false);

  const finish = useCallback(
    async (board: UserBoard) => {
      await setActiveBoard(board);
      router.dismissTo(boardReturnTo);
    },
    [setActiveBoard, router, boardReturnTo],
  );

  /**
   * Always calls the server. The old short-circuit — activate an owned board
   * whose config matched and skip the mutation — is what made #4166 look like a
   * success while silently discarding the form, so there is deliberately no
   * client-side path that can complete a create without a server round trip.
   * The server decides whether this is a duplicate, and the user decides what to
   * do about it.
   */
  const handleCreate = useCallback(
    async (options?: { allowDuplicateConfig?: boolean }) => {
      if (inFlightRef.current) return;
      const input = builder.buildCreateInput(defaultName);
      if (!input) return;
      inFlightRef.current = true;
      setSubmitting(true);
      setCreateError(null);
      hapticSelection();

      try {
        const board = await createBoard.mutateAsync({
          ...input,
          allowDuplicateConfig: options?.allowDuplicateConfig || undefined,
        });
        track(SHARED_EVENTS.BoardCreated, {
          ...describeInput(input, source),
          allowedDuplicate: !!options?.allowDuplicateConfig,
        });
        await finish(board);
        // Navigated away on success — no need to clear `submitting` (unmounting).
      } catch (error) {
        const duplicateError = readDuplicateBoardError(error);
        if (duplicateError) {
          track(SHARED_EVENTS.BoardDuplicatePrompted, {
            boardType: input.boardType,
            source,
            hasLocation: !!input.locationName || (input.latitude != null && input.longitude != null),
          });
          setDuplicate(duplicateError);
          inFlightRef.current = false;
          setSubmitting(false);
          return;
        }
        track(SHARED_EVENTS.BoardCreateFailed, {
          boardType: input.boardType,
          source,
          error_reason: classifyCreateFailure(error),
        });
        // Inline, never a toast: this screen is a `presentation: 'modal'` route
        // and the toast overlay renders behind it, so a toast here is invisible.
        setCreateError(extractGraphqlMessage(error) ?? t('mobile.create.createError'));
        inFlightRef.current = false;
        setSubmitting(false);
      }
    },
    [builder, defaultName, createBoard, finish, source, t],
  );

  const handleUseExisting = useCallback(async () => {
    if (!duplicate || inFlightRef.current) return;
    inFlightRef.current = true;
    setSubmitting(true);
    try {
      const board = await fetchBoardByUuid(duplicate.boardUuid);
      if (!board) throw new Error('Board not found');
      track(SHARED_EVENTS.BoardCreateReusedExisting, { boardType: builder.boardName, source });
      setDuplicate(null);
      await finish(board);
    } catch {
      setDuplicate(null);
      setCreateError(t('mobile.create.duplicate.switchError'));
      inFlightRef.current = false;
      setSubmitting(false);
    }
  }, [duplicate, builder.boardName, source, finish, t]);

  const handleAddAnother = useCallback(() => {
    setDuplicate(null);
    void handleCreate({ allowDuplicateConfig: true });
  }, [handleCreate]);

  const handleDismissDuplicate = useCallback(() => {
    setDuplicate(null);
    inFlightRef.current = false;
    setSubmitting(false);
  }, []);

  return (
    <>
      <BoardForm
        builder={builder}
        defaultName={defaultName}
        submitting={submitting}
        errorMessage={createError}
        onSubmit={() => void handleCreate()}
        submitLabel={t('mobile.create.save')}
      />
      {duplicate && (
        <BoardDuplicatePromptSheet
          duplicate={duplicate}
          busy={submitting}
          onUseExisting={() => void handleUseExisting()}
          onAddAnother={handleAddAnother}
          onDismiss={handleDismissDuplicate}
        />
      )}
    </>
  );
}
