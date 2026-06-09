import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { randomUUID } from 'expo-crypto';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type { BoardName, Climb } from '@boardsesh/shared-schema';
import { isNoMatchClimb, withNoMatch } from '@boardsesh/shared-schema';
import {
  useCreateClimb,
  computeCanUpdate,
  computeEditLocked,
  buildInitialHoldsMap,
  type SavedClimbSnapshot,
} from '@boardsesh/create-climb-react';
import { useBoardProvider, isDuplicateClimbError } from '@boardsesh/board-react';
import { GraphQLOperationError } from '@boardsesh/graphql-client';
import { getLayoutName } from '@boardsesh/board-constants/product-sizes';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../../lib/analytics';
import { useAuth } from '../../providers/auth-provider';
import { useProfile, useClimb } from '../../lib/graphql/hooks';
import { useQueue } from '../../providers/queue-provider';
import { useOptionalBluetoothContext } from '../../providers/bluetooth-provider';
import { useToast } from '../../providers/toast-provider';
import { climbToQueueItem } from '../../lib/climb-to-queue-item';
import { loadDraft, saveDraft, clearDraft, createClimbDraftKey } from '../../lib/create-climb-draft-store';
import { getPaintRoles, type BrushRole } from './brush-roles';

// The save button's visual state, derived from auth + the saved-climb snapshot +
// in-flight state. Lives here (the controller computes it) so the UI imports it.
export type SaveButtonState = 'ready' | 'saving' | 'justSaved' | 'editLocked' | 'login';

export type CreateClimbBoard = {
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
};

type UseCreateClimbScreenArgs = {
  board: CreateClimbBoard;
  /** Single-frame holds string to seed a fork from (no savedClimb tracked). */
  forkFrames?: string;
  forkName?: string;
  forkDescription?: string;
  /** When set, fetch and edit this existing climb in place. */
  editClimbUuid?: string;
  /** Called after a successful publish (non-draft save) so the screen can
   *  dismiss the drawer and let the success toast show over the list. */
  onPublished?: () => void;
};

const AUTOSAVE_DEBOUNCE_MS = 500;
const BLE_PREVIEW_DEBOUNCE_MS = 250;
const JUST_SAVED_MS = 3000;

/** Duplicate-publish detail surfaced inline so the user can view the match. */
export type PublishDuplicateError = {
  existingClimbUuid: string | null;
  existingClimbName: string | null;
};

function readDuplicateExtensions(err: unknown): PublishDuplicateError {
  if (err instanceof GraphQLOperationError) {
    const extensions = err.extensions as { existingClimbUuid?: unknown; existingClimbName?: unknown } | undefined;
    return {
      existingClimbUuid: typeof extensions?.existingClimbUuid === 'string' ? extensions.existingClimbUuid : null,
      existingClimbName: typeof extensions?.existingClimbName === 'string' ? extensions.existingClimbName : null,
    };
  }
  return { existingClimbUuid: null, existingClimbName: null };
}

/**
 * The create-climb screen controller. Composes the shared hold-state machine
 * with auth, the board provider's save/update mutations, the per-board local
 * autosave, BLE preview, and the queue, and exposes a save state machine the
 * create drawer's action bar renders.
 */
export function useCreateClimbScreen({
  board,
  forkFrames,
  forkName,
  forkDescription,
  editClimbUuid,
  onPublished,
}: UseCreateClimbScreenArgs) {
  const router = useRouter();
  const { t } = useTranslation('climbs');
  const { isAuthenticated, saveClimb, updateClimb } = useBoardProvider();
  const auth = useAuth();
  const { data: profile } = useProfile();
  const { setCurrentClimb } = useQueue();
  const bluetooth = useOptionalBluetoothContext();
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  const isForking = !!forkFrames;
  const isEditing = !!editClimbUuid;

  // Seed the editor from a fork's frames once; an empty start otherwise. Edit
  // mode seeds asynchronously below (guarded by a ref).
  const initialHoldsMap = useMemo(
    () => (isForking && forkFrames ? buildInitialHoldsMap(forkFrames, board.boardName) : {}),
    // Seed only once from the route param — board.boardName is stable per screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const {
    litUpHoldsMap,
    setHoldState,
    generateFramesString,
    startingCount,
    finishCount,
    totalHolds,
    isValid,
    resetHolds,
    loadHolds,
    undo,
    redo,
    canUndo,
    canRedo,
  } = useCreateClimb(board.boardName, { initialHoldsMap });

  const [selectedBrush, setSelectedBrush] = useState<BrushRole>('HAND');
  const [name, setName] = useState(isForking && forkName ? `${forkName} fork` : '');
  const [description, setDescription] = useState(
    isForking && forkDescription ? withNoMatch(forkDescription, false) : '',
  );
  // The "no match" climb rule is a separate boolean in the editor; we encode it
  // into the description (a leading "No match" line — see isNoMatchClimb) only at
  // save time, so the editable description field stays clean and the toggle never
  // gets stuck on a fuzzy match. A follow-up migrates this to a real column.
  const [noMatch, setNoMatch] = useState(isForking && forkDescription ? isNoMatchClimb(forkDescription) : false);
  const [isDraft, setIsDraft] = useState(true);
  const [showAllHolds, setShowAllHolds] = useState(false);

  const [savedClimb, setSavedClimb] = useState<SavedClimbSnapshot | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [publishDuplicateError, setPublishDuplicateError] = useState<PublishDuplicateError | null>(null);

  useEffect(() => {
    setSelectedBrush((currentBrush) => {
      if (currentBrush === 'OFF') return currentBrush;
      const supportedRoles = getPaintRoles(board.boardName);
      return supportedRoles.includes(currentBrush) ? currentBrush : (supportedRoles[0] ?? 'HAND');
    });
  }, [board.boardName]);

  const draftKey = useMemo(() => createClimbDraftKey(board), [board]);
  // Skip the local-autosave restore when forking or editing (those seed from
  // their own source); also skip until the initial restore lands.
  const skipRestoreRef = useRef(isForking || isEditing);
  const restoredRef = useRef(false);
  // Stable provisional queue-item uuid for an unsaved WIP, so re-tapping "Set as
  // active" updates the same queue slot instead of appending a new item each tap.
  const previewUuidRef = useRef<string | null>(null);
  if (!previewUuidRef.current) previewUuidRef.current = randomUUID();
  // Tracked so the just-saved confirmation timer is cleared on unmount.
  const justSavedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (justSavedTimerRef.current) clearTimeout(justSavedTimerRef.current);
    },
    [],
  );

  // ---- Edit mode: fetch the climb and seed the editor once. ----
  const editVariables = useMemo(
    () =>
      isEditing && editClimbUuid
        ? {
            boardName: board.boardName,
            layoutId: board.layoutId,
            sizeId: board.sizeId,
            setIds: board.setIds,
            angle: board.angle,
            climbUuid: editClimbUuid,
          }
        : null,
    [isEditing, editClimbUuid, board],
  );
  const { data: editClimb } = useClimb(editVariables);
  const editSeededRef = useRef(false);
  useEffect(() => {
    if (!editClimb || editSeededRef.current) return;
    editSeededRef.current = true;
    loadHolds(buildInitialHoldsMap(editClimb.frames, board.boardName));
    setName(editClimb.name);
    setDescription(withNoMatch(editClimb.description ?? '', false));
    setNoMatch(isNoMatchClimb(editClimb.description));
    setIsDraft(editClimb.is_draft ?? false);
    setSavedClimb({
      uuid: editClimb.uuid,
      boardType: board.boardName,
      createdAt: editClimb.created_at ?? null,
      publishedAt: editClimb.published_at ?? null,
      isDraft: editClimb.is_draft ?? false,
    });
  }, [editClimb, board.boardName, loadHolds]);

  // ---- Local autosave restore on mount. ----
  useEffect(() => {
    if (skipRestoreRef.current) {
      restoredRef.current = true;
      return;
    }
    let cancelled = false;
    void loadDraft(draftKey).then((draft) => {
      if (cancelled || !draft) {
        restoredRef.current = true;
        return;
      }
      try {
        const parsed = JSON.parse(draft.holdsJson) as Record<number, { state: string }>;
        loadHolds(parsed as Parameters<typeof loadHolds>[0]);
      } catch {
        // Corrupt holds payload — ignore and start clean.
      }
      setName(draft.name);
      setDescription(withNoMatch(draft.description, false));
      setNoMatch(isNoMatchClimb(draft.description));
      setIsDraft(draft.isDraft);
      restoredRef.current = true;
    });
    return () => {
      cancelled = true;
    };
    // draftKey is stable per screen mount; restore once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Local autosave (debounced). ----
  const holdsJson = useMemo(() => JSON.stringify(litUpHoldsMap), [litUpHoldsMap]);
  useEffect(() => {
    if (!restoredRef.current) return;
    // Edit mode operates on an existing climb — never persist it into the
    // per-board new-draft autosave slot, or it resurfaces as a phantom draft.
    if (isEditing) return;
    // Once the WIP has been saved, stop autosaving. `handleSave` clears the
    // draft and sets `savedClimb`; without this guard the debounced timer would
    // re-write the just-cleared draft and resurface it as a phantom on reopen.
    if (savedClimb) return;
    const hasContent = holdsJson !== '{}' || name.trim() !== '' || description.trim() !== '';
    const handle = setTimeout(() => {
      if (!hasContent) {
        void clearDraft(draftKey);
        return;
      }
      void saveDraft(draftKey, { holdsJson, name, description: withNoMatch(description, noMatch), isDraft });
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [holdsJson, name, description, noMatch, isDraft, draftKey, savedClimb]);

  // ---- BLE preview (debounced) while connected. ----
  const sendFramesRef = useRef(bluetooth?.sendFramesToBoard);
  sendFramesRef.current = bluetooth?.sendFramesToBoard;
  const bleConnected = bluetooth?.isConnected ?? false;
  useEffect(() => {
    if (!bleConnected) return;
    const handle = setTimeout(() => {
      void sendFramesRef.current?.(generateFramesString());
    }, BLE_PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [holdsJson, bleConnected, generateFramesString]);

  // ---- Painting + role assignment. ----
  const handlePaint = useCallback(
    (holdId: number) => {
      setHoldState(holdId, selectedBrush);
    },
    [setHoldState, selectedBrush],
  );

  const handleAssignRole = useCallback(
    (holdId: number, role: BrushRole) => {
      setHoldState(holdId, role);
    },
    [setHoldState],
  );

  const handleClear = useCallback(() => {
    resetHolds();
    // Treat Clear as a brand-new climb: wipe name/description/draft flag too, or
    // a Save straight after Clear reuses the old name and skips the name prompt.
    setName('');
    setDescription('');
    setIsDraft(true);
    setSavedClimb(null);
    setPublishDuplicateError(null);
    // Fresh climb identity for the next WIP so its queue item is independent.
    previewUuidRef.current = randomUUID();
    void clearDraft(draftKey);
  }, [resetHolds, draftKey]);

  // Build a minimal Climb the queue can hold for a not-yet-saved or just-saved
  // climb. The mutation input (`ClimbInput`) is a strict subset of Climb, so
  // these placeholder grade fields are never sent to the server — they only
  // satisfy the type and render neutral values in the queue UI.
  const buildProvisionalClimb = useCallback(
    (uuid: string, frames: string): Climb => ({
      uuid,
      name: name.trim() || t('createClimbForm.draftBadge'),
      frames,
      setter_username: profile?.displayName ?? '',
      angle: board.angle,
      ascensionist_count: 0,
      difficulty: '',
      quality_average: '0',
      stars: 0,
      difficulty_error: '0',
      benchmark_difficulty: null,
    }),
    [name, profile, board.angle, t],
  );

  // Push the freshly saved climb into the queue as the current climb so the
  // board (and any connected BLE wall) reflects what was just published.
  // Known limitation: re-saving a climb that is ALREADY the active queue item
  // won't refresh its frames via the queue — the reducer short-circuits a
  // same-uuid local SET_CURRENT_CLIMB. The live BLE preview keeps the local
  // wall correct; a mobile queue `updateQueueItem` is the follow-up for peers.
  const syncSavedToQueue = useCallback(
    (uuid: string, frames: string) => {
      setCurrentClimb(climbToQueueItem(buildProvisionalClimb(uuid, frames), { uuid }));
    },
    [buildProvisionalClimb, setCurrentClimb],
  );

  // ---- Set Active: build a minimal Climb and push to the queue. ----
  const handleSetActive = useCallback(() => {
    const frames = generateFramesString();
    if (!frames) return;
    const uuid = savedClimb?.uuid ?? previewUuidRef.current ?? randomUUID();
    setCurrentClimb(climbToQueueItem(buildProvisionalClimb(uuid, frames), { uuid }));
  }, [generateFramesString, savedClimb, buildProvisionalClimb, setCurrentClimb]);

  // ---- BLE toggle (drives the header lightbulb): connect lights the wall with
  // the current holds; tapping again disconnects. ----
  const handleToggleBle = useCallback(() => {
    if (!bluetooth) return;
    if (bluetooth.isConnected) void bluetooth.disconnect();
    else void bluetooth.connect(generateFramesString());
  }, [bluetooth, generateFramesString]);

  // ---- Save state machine. ----
  const editLocked = computeEditLocked(savedClimb);
  const canUpdate = computeCanUpdate(savedClimb, board.boardName);

  const saveState: SaveButtonState = useMemo(() => {
    if (!isAuthenticated) return 'login';
    if (isSaving) return 'saving';
    if (justSaved) return 'justSaved';
    if (editLocked) return 'editLocked';
    return 'ready';
  }, [isAuthenticated, isSaving, justSaved, editLocked]);

  // Signal the screen should focus the header name field (e.g. on a save with
  // no name yet). The name input lives in the drawer header, not a settings sheet.
  const [focusNameSignal, setFocusNameSignal] = useState(0);
  const requestFocusName = useCallback(() => setFocusNameSignal((value) => value + 1), []);

  const handleSave = useCallback(async () => {
    if (!isAuthenticated) {
      router.push('/auth/login');
      return;
    }
    if (editLocked) return;
    if (!isValid) return;
    if (name.trim() === '') {
      requestFocusName();
      return;
    }

    setIsSaving(true);
    setPublishDuplicateError(null);
    const frames = generateFramesString();
    // Encode the no-match marker into the description only at save time.
    const fullDescription = withNoMatch(description, noMatch);
    // Mirror web's `holdCount` property (create-climb-form.tsx), which sends the
    // hook's `totalHolds` (non-OFF holds only) — not the raw map size.
    const holdCount = totalHolds;
    // Web sends the human-readable layout name (`boardDetails.layout_name || ''`)
    // for `boardLayout`; mobile only carries the numeric layout id, so resolve it
    // to the same name via the shared board-constants table. PostHog groups by
    // exact value, so the string must match web for these create-climb events.
    const boardLayout = getLayoutName(board.boardName, board.layoutId);
    try {
      if (canUpdate && savedClimb) {
        const result = await updateClimb({
          uuid: savedClimb.uuid,
          boardType: board.boardName,
          name: name.trim(),
          description: fullDescription,
          frames,
          angle: board.angle,
          isDraft,
        });
        setSavedClimb({
          uuid: result.uuid,
          boardType: board.boardName,
          createdAt: result.createdAt ?? savedClimb.createdAt,
          publishedAt: result.publishedAt ?? savedClimb.publishedAt,
          isDraft: result.isDraft,
        });
        // Match web's schema exactly (create-climb-form.tsx) so PostHog funnels
        // that group by these props line up across platforms. `boardLayout` is the
        // resolved layout NAME (same value web sends), not the numeric id.
        track(SHARED_EVENTS.ClimbUpdated, {
          boardLayout,
          isDraft: result.isDraft,
          holdCount,
        });
        syncSavedToQueue(result.uuid, frames);
      } else {
        const result = await saveClimb({
          layout_id: board.layoutId,
          name: name.trim(),
          description: fullDescription,
          is_draft: isDraft,
          frames,
          angle: board.angle,
        });
        setSavedClimb({
          uuid: result.uuid,
          boardType: board.boardName,
          createdAt: result.createdAt ?? null,
          publishedAt: result.publishedAt ?? null,
          isDraft,
        });
        // Match web's schema exactly (create-climb-form.tsx). See ClimbUpdated above.
        track(SHARED_EVENTS.ClimbCreated, {
          boardLayout,
          isDraft,
          holdCount,
        });
        syncSavedToQueue(result.uuid, frames);
      }
      await clearDraft(draftKey);
      // Refresh the inline Open Drafts table so the just-saved climb appears /
      // updates (delete already invalidates these keys; save must too).
      queryClient.invalidateQueries({ queryKey: ['searchClimbs'] });
      queryClient.invalidateQueries({ queryKey: ['searchClimbsCount'] });
      setJustSaved(true);
      showToast(isDraft ? t('mobile.create.save.draftToast') : t('mobile.create.save.publishedToast'), 'success');
      // A publish is commit-and-done — dismiss the drawer so the toast shows
      // over the climbs list (drafts stay open so you can keep editing).
      if (!isDraft) onPublished?.();
      if (justSavedTimerRef.current) clearTimeout(justSavedTimerRef.current);
      justSavedTimerRef.current = setTimeout(() => setJustSaved(false), JUST_SAVED_MS);
    } catch (err) {
      // Web emits only `{ boardLayout }` for this event (create-climb-form.tsx);
      // match that (resolved layout NAME), plus a mobile-only `error_reason` that
      // doesn't affect any grouping web relies on.
      track(SHARED_EVENTS.ClimbCreateFailed, {
        boardLayout,
        error_reason: isDuplicateClimbError(err) ? 'duplicate' : 'exception',
      });
      if (isDuplicateClimbError(err)) {
        setPublishDuplicateError(readDuplicateExtensions(err));
      } else {
        showToast(t('createClimbForm.alerts.saveFailedFallback'), 'error');
      }
    } finally {
      setIsSaving(false);
    }
  }, [
    isAuthenticated,
    router,
    editLocked,
    isValid,
    name,
    canUpdate,
    savedClimb,
    totalHolds,
    generateFramesString,
    updateClimb,
    saveClimb,
    board,
    description,
    noMatch,
    isDraft,
    draftKey,
    requestFocusName,
    syncSavedToQueue,
    showToast,
    t,
    queryClient,
    onPublished,
  ]);

  const dismissDuplicateError = useCallback(() => setPublishDuplicateError(null), []);

  const canSetActive = isValid;

  return {
    // editor state
    litUpHoldsMap,
    startingCount,
    finishCount,
    isValid,
    selectedBrush,
    setSelectedBrush,
    handlePaint,
    handleAssignRole,
    handleClear,
    showAllHolds,
    setShowAllHolds,
    // undo/redo (current editing session only)
    undo,
    redo,
    canUndo,
    canRedo,
    // form fields
    name,
    setName,
    description,
    setDescription,
    isDraft,
    setIsDraft,
    noMatch,
    setNoMatch,
    // save
    saveState,
    handleSave,
    canSetActive,
    handleSetActive,
    publishDuplicateError,
    dismissDuplicateError,
    focusNameSignal,
    // ble
    bleAvailable: !!bluetooth,
    bleConnected,
    bleConnecting: bluetooth?.loading ?? false,
    handleToggleBle,
    // auth (re-export so the screen can render a login affordance if needed)
    isAuthenticated,
    refreshAuthState: auth.refreshAuthState,
  };
}
