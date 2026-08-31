import { useCallback, useMemo, useRef, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { toBoardName } from '@boardsesh/board-config';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import type { CreateBoardInput, UserBoard } from '@boardsesh/shared-schema';
import {
  useCreateBoard,
  useFollowBoard,
  useProfile,
  fetchBoardByUuid,
  fetchBoardsBySerialNumbers,
} from '../../src/lib/graphql/hooks';
import { useActivateBoard } from '../../src/lib/boards/use-activate-board';
import {
  extractGraphqlMessage,
  isGraphqlRateLimitedError,
  isExpectedAuthError,
  isBoardLimitError,
  readDuplicateBoardError,
  type DuplicateBoardError,
} from '../../src/lib/graphql/extract-error-message';
import { track } from '../../src/lib/analytics';
import { useAuth } from '../../src/providers/auth-provider';
import { hapticSelection } from '../../src/lib/haptics';
import { resolveBoardReturnTo } from '../../src/lib/boards/board-return-to';
import {
  selectForeignSerialBoards,
  boardConfigMatches,
  extractSerialExistsError,
  serialReuseDisclosure,
} from '../../src/lib/boards/serial-reuse';
import { useBoardBuilder, type BoardBuilderSeed } from '../../src/components/board-discovery/use-board-builder';
import { BoardForm } from '../../src/components/board-discovery/BoardForm';
import { BoardDuplicatePromptSheet } from '../../src/components/board-discovery/BoardDuplicatePromptSheet';
import { SerialReuseConfirmSheet } from '../../src/components/board-discovery/SerialReuseConfirmSheet';
import { formatDefaultBoardName } from '../../src/components/board-discovery/board-builder-labels';

/**
 * The overrides the climber has explicitly granted so far.
 *
 * The two guards are independent and can fire one after the other on the same
 * create: "yes, this really is a second wall that reuses a serial" says nothing
 * about "yes, I really do own two walls with this configuration". Confirming one
 * must never imply the other, so each flag is set only by its own prompt — and
 * both ride along on the retry once granted, otherwise confirming the second
 * guard would re-trip the first.
 */
type CreateOverrides = {
  allowDuplicateSerial?: boolean;
  allowDuplicateConfig?: boolean;
};

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

function classifyCreateFailure(error: unknown): 'rate_limited' | 'auth' | 'board_limit' | 'exception' {
  if (isGraphqlRateLimitedError(error)) return 'rate_limited';
  if (isExpectedAuthError(error)) return 'auth';
  // Ahead of the catch-all so the account cap doesn't disappear into
  // `exception` — it needs its own copy, and retrying will never clear it.
  if (isBoardLimitError(error)) return 'board_limit';
  return 'exception';
}

export default function CreateBoard() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    returnTo?: string;
    source?: string;
    seedBoardName?: string;
    seedLayoutId?: string;
    seedSizeId?: string;
    seedSetIds?: string;
  }>();
  const boardReturnTo = resolveBoardReturnTo(params.returnTo);
  // Threaded through the picker from the first-run flow. Creating a board is one
  // of the ways a climber binds their first one, so it has to close out
  // onboarding exactly like picking an existing board does.
  const fromOnboarding = params.source === 'onboarding';
  const { isAuthenticated } = useAuth();
  const { t } = useTranslation('boards');

  const createBoard = useCreateBoard();
  const followBoard = useFollowBoard();
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
  // The duplicate-CONFIG prompt: the caller already owns this configuration at
  // this place. `granted` carries any override already confirmed on the attempt
  // that raised it, so answering this one doesn't discard the other.
  const [duplicate, setDuplicate] = useState<{ error: DuplicateBoardError; granted: CreateOverrides } | null>(null);
  // The duplicate-SERIAL prompt: another climber's wall already carries this
  // serial with the same config. A null board means that wall is private (the
  // backend masks its identity) — the sheet still offers "create anyway", just
  // without a jump.
  const [serialReuse, setSerialReuse] = useState<{
    board: UserBoard | null;
    input: CreateBoardInput;
    granted: CreateOverrides;
  } | null>(null);
  // `submitting` is only accurate on the NEXT render, so it can't guard a call
  // that fires in the same tick as the state update — which is exactly what
  // "add a new board here" does (dismiss the sheet, then create). This ref is
  // set synchronously and is the real in-flight lock.
  const inFlightRef = useRef(false);

  // A board the climber just built is theirs by construction, so there is
  // nothing to adopt — `isLocalOnly` skips the follow-and-download pass.
  const finish = useActivateBoard({
    source: fromOnboarding ? 'onboarding' : undefined,
    returnTo: boardReturnTo,
    isLocalOnly: true,
  });

  /**
   * Always calls the server. The old short-circuit — activate an owned board
   * whose config matched and skip the mutation — is what made #4166 look like a
   * success while silently discarding the form, so there is deliberately no
   * client-side path that can complete a create without a server round trip.
   * The server decides whether this is a duplicate, and the user decides what to
   * do about it.
   */
  const handleCreate = useCallback(
    async (overrides?: CreateOverrides) => {
      if (inFlightRef.current) return;
      const input = builder.buildCreateInput(defaultName);
      if (!input) return;
      const granted: CreateOverrides = {
        allowDuplicateSerial: overrides?.allowDuplicateSerial || undefined,
        allowDuplicateConfig: overrides?.allowDuplicateConfig || undefined,
      };
      inFlightRef.current = true;
      setSubmitting(true);
      setCreateError(null);
      hapticSelection();

      // Pre-submit serial-reuse check: if another climber's wall already carries
      // this serial WITH THE SAME CONFIG, steer the user onto it before creating
      // a duplicate. A different-config match is legitimate reuse the backend
      // allows — prompting there would send the user to an unrelated wall. A
      // lookup failure is non-blocking — fall through to the normal create.
      const serial = granted.allowDuplicateSerial ? null : input.serialNumber?.trim();
      if (serial) {
        const config = {
          boardType: input.boardType,
          layoutId: input.layoutId,
          sizeId: input.sizeId,
          setIds: input.setIds,
        };
        const sameConfigBoard = await fetchBoardsBySerialNumbers([serial])
          .then(
            (boards) =>
              selectForeignSerialBoards(boards, config).find((board) => boardConfigMatches(board, config)) ?? null,
          )
          .catch(() => null);
        if (sameConfigBoard) {
          // Authenticated serial lookup intentionally returns private matches so
          // the create guard can identify a collision. Do not carry that private
          // entity into UI state: its name, location, and owner are not ours to
          // reveal, and the identity-free sheet must not offer a jump to it.
          const disclosure = serialReuseDisclosure(sameConfigBoard);
          setSerialReuse({ board: disclosure.kind === 'public' ? disclosure.board : null, input, granted });
          inFlightRef.current = false;
          setSubmitting(false);
          return;
        }
      }

      try {
        const board = await createBoard.mutateAsync({ ...input, ...granted });
        track(SHARED_EVENTS.BoardCreated, {
          ...describeInput(input, source),
          allowedDuplicate: !!granted.allowDuplicateConfig,
          allowedDuplicateSerial: !!granted.allowDuplicateSerial,
        });
        await finish(board);
        // Navigated away on success — no need to clear `submitting` (unmounting).
      } catch (error) {
        // The backend's serial guard, raced past the pre-submit check above (or
        // reached with no serial lookup at all). Independent of the config guard
        // below: whichever the server raised is the one we prompt for.
        const serialExists = granted.allowDuplicateSerial ? null : extractSerialExistsError(error);
        if (serialExists) {
          // A failed re-fetch (transient network, or the board vanished in a
          // race) must not dead-end the user — fall back to the identity-less
          // sheet, same as the private path, so "create anyway" stays reachable.
          const existing =
            serialExists.kind === 'private' ? null : await fetchBoardByUuid(serialExists.boardUuid).catch(() => null);
          const disclosure = existing ? serialReuseDisclosure(existing) : null;
          setSerialReuse({ board: disclosure?.kind === 'public' ? disclosure.board : null, input, granted });
          inFlightRef.current = false;
          setSubmitting(false);
          return;
        }
        const duplicateError = readDuplicateBoardError(error);
        if (duplicateError) {
          track(SHARED_EVENTS.BoardDuplicatePrompted, {
            boardType: input.boardType,
            source,
            hasLocation: !!input.locationName || (input.latitude != null && input.longitude != null),
          });
          setDuplicate({ error: duplicateError, granted });
          inFlightRef.current = false;
          setSubmitting(false);
          return;
        }
        const reason = classifyCreateFailure(error);
        track(SHARED_EVENTS.BoardCreateFailed, {
          boardType: input.boardType,
          source,
          error_reason: reason,
        });
        // Inline, never a toast: this screen is a `presentation: 'modal'` route
        // and the toast overlay renders behind it, so a toast here is invisible.
        // The cap gets our own copy rather than the server's message: what the
        // climber needs is the way out (delete one you don't use), not the number.
        setCreateError(
          reason === 'board_limit'
            ? t('mobile.create.limitReached')
            : (extractGraphqlMessage(error) ?? t('mobile.create.createError')),
        );
        inFlightRef.current = false;
        setSubmitting(false);
      }
    },
    [builder, defaultName, createBoard, finish, source, t],
  );

  const handleUseExistingDuplicate = useCallback(async () => {
    if (!duplicate || inFlightRef.current) return;
    inFlightRef.current = true;
    setSubmitting(true);
    try {
      const board = await fetchBoardByUuid(duplicate.error.boardUuid);
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
    const granted = duplicate?.granted;
    setDuplicate(null);
    void handleCreate({ ...granted, allowDuplicateConfig: true });
  }, [duplicate, handleCreate]);

  const handleDismissDuplicate = useCallback(() => {
    setDuplicate(null);
    inFlightRef.current = false;
    setSubmitting(false);
  }, []);

  /**
   * "Use the existing board" on the serial sheet: follow it so it joins the
   * user's board list, then activate and leave. A failed follow must not
   * activate a board the user still cannot reach later.
   */
  const handleUseExistingSerial = useCallback(async () => {
    // No board to jump to when the conflicting wall is private (masked payload)
    // — the sheet hides the "use existing" action in that case.
    if (!serialReuse?.board || inFlightRef.current) return;
    const { board } = serialReuse;
    setSerialReuse(null);
    inFlightRef.current = true;
    setSubmitting(true);
    try {
      await followBoard.mutateAsync(board);
      await finish(board);
    } catch {
      setCreateError(t('mobile.create.createError'));
      inFlightRef.current = false;
      setSubmitting(false);
    }
  }, [serialReuse, followBoard, finish, t]);

  const handleCreateAnyway = useCallback(() => {
    if (!serialReuse) return;
    const { granted } = serialReuse;
    setSerialReuse(null);
    void handleCreate({ ...granted, allowDuplicateSerial: true });
  }, [serialReuse, handleCreate]);

  const handleCancelSerialReuse = useCallback(() => {
    setSerialReuse(null);
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
          duplicate={duplicate.error}
          busy={submitting}
          onUseExisting={() => void handleUseExistingDuplicate()}
          onAddAnother={handleAddAnother}
          onDismiss={handleDismissDuplicate}
        />
      )}
      <SerialReuseConfirmSheet
        visible={serialReuse !== null}
        board={serialReuse?.board ?? null}
        serialNumber={serialReuse?.input.serialNumber ?? ''}
        onUseExisting={() => void handleUseExistingSerial()}
        onCreateAnyway={handleCreateAnyway}
        onCancel={handleCancelSerialReuse}
      />
    </>
  );
}
