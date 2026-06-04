import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { randomUUID } from 'expo-crypto';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { BoardName, Climb } from '@boardsesh/shared-schema';
import {
  useCreateClimb,
  computeCanUpdate,
  computeEditLocked,
  buildInitialHoldsMap,
  type SavedClimbSnapshot,
} from '@boardsesh/create-climb-react';
import { useBoardProvider, isDuplicateClimbError } from '@boardsesh/board-react';
import { GraphQLOperationError } from '@boardsesh/graphql-client';
import { useAuth } from '../../providers/auth-provider';
import { useProfile, useClimb } from '../../lib/graphql/hooks';
import { useQueue } from '../../providers/queue-provider';
import { useOptionalBluetoothContext } from '../../providers/bluetooth-provider';
import { useToast } from '../../providers/toast-provider';
import { climbToQueueItem } from '../../lib/climb-to-queue-item';
import { loadDraft, saveDraft, clearDraft, createClimbDraftKey } from '../../lib/create-climb-draft-store';
import type { BrushRole } from './brush-roles';
import type { SaveButtonState } from './BrushBar';

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
 * BrushBar renders.
 */
export function useCreateClimbScreen({
  board,
  forkFrames,
  forkName,
  forkDescription,
  editClimbUuid,
}: UseCreateClimbScreenArgs) {
  const router = useRouter();
  const { t } = useTranslation('climbs');
  const { isAuthenticated, saveClimb, updateClimb } = useBoardProvider();
  const auth = useAuth();
  const { data: profile } = useProfile();
  const { setCurrentClimb } = useQueue();
  const bluetooth = useOptionalBluetoothContext();
  const { showToast } = useToast();

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
    isValid,
    resetHolds,
    loadHolds,
  } = useCreateClimb(board.boardName, { initialHoldsMap });

  const [selectedBrush, setSelectedBrush] = useState<BrushRole>('HAND');
  const [name, setName] = useState(isForking && forkName ? `${forkName} fork` : '');
  const [description, setDescription] = useState(isForking && forkDescription ? forkDescription : '');
  const [isDraft, setIsDraft] = useState(true);
  const [showAllHolds, setShowAllHolds] = useState(false);

  const [savedClimb, setSavedClimb] = useState<SavedClimbSnapshot | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [publishDuplicateError, setPublishDuplicateError] = useState<PublishDuplicateError | null>(null);

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

  // A saved climb belongs to the angle it was saved at. The screen stays mounted
  // across angle changes (the route re-memoises `board`), so a new working angle
  // means a new climb (same holds, different angle). Drop the saved identity and
  // mint a fresh preview uuid so Save creates a new row at the new angle and Set
  // Active carries the right angle — otherwise the queue item would pair the old
  // uuid with the new angle. Mirrors the per-angle autosave draft key.
  const lastAngleRef = useRef(board.angle);
  useEffect(() => {
    if (lastAngleRef.current === board.angle) return;
    lastAngleRef.current = board.angle;
    // Edit identity comes from editClimbUuid (seeded once), not the working angle.
    if (isEditing) return;
    setSavedClimb(null);
    setPublishDuplicateError(null);
    previewUuidRef.current = randomUUID();
  }, [board.angle, isEditing]);

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
    setDescription(editClimb.description ?? '');
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
      setDescription(draft.description);
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
    const hasContent = Object.keys(litUpHoldsMap).length > 0 || name.trim() !== '' || description.trim() !== '';
    const handle = setTimeout(() => {
      if (!hasContent) {
        void clearDraft(draftKey);
        return;
      }
      void saveDraft(draftKey, { holdsJson, name, description, isDraft });
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [holdsJson, name, description, isDraft, draftKey, litUpHoldsMap]);

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

  // ---- BLE connect. ----
  const handleConnectBoard = useCallback(() => {
    if (!bluetooth) return;
    void bluetooth.connect(generateFramesString());
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

  // Signal the screen should open the settings sheet (e.g. to fill in a name).
  const [openSettingsSignal, setOpenSettingsSignal] = useState(0);
  const requestOpenSettings = useCallback(() => setOpenSettingsSignal((value) => value + 1), []);

  const handleSave = useCallback(async () => {
    if (!isAuthenticated) {
      router.push('/auth/login');
      return;
    }
    if (editLocked) return;
    if (!isValid) return;
    if (name.trim() === '') {
      requestOpenSettings();
      return;
    }

    setIsSaving(true);
    setPublishDuplicateError(null);
    const frames = generateFramesString();
    try {
      if (canUpdate && savedClimb) {
        const result = await updateClimb({
          uuid: savedClimb.uuid,
          boardType: board.boardName,
          name: name.trim(),
          description,
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
        syncSavedToQueue(result.uuid, frames);
      } else {
        const result = await saveClimb({
          layout_id: board.layoutId,
          name: name.trim(),
          description,
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
        syncSavedToQueue(result.uuid, frames);
      }
      await clearDraft(draftKey);
      setJustSaved(true);
      if (justSavedTimerRef.current) clearTimeout(justSavedTimerRef.current);
      justSavedTimerRef.current = setTimeout(() => setJustSaved(false), JUST_SAVED_MS);
    } catch (err) {
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
    generateFramesString,
    updateClimb,
    saveClimb,
    board,
    description,
    isDraft,
    draftKey,
    requestOpenSettings,
    syncSavedToQueue,
    showToast,
    t,
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
    // form fields
    name,
    setName,
    description,
    setDescription,
    isDraft,
    setIsDraft,
    // save
    saveState,
    handleSave,
    canSetActive,
    handleSetActive,
    publishDuplicateError,
    dismissDuplicateError,
    openSettingsSignal,
    // ble
    bleAvailable: !!bluetooth,
    bleConnected,
    bleConnecting: bluetooth?.loading ?? false,
    handleConnectBoard,
    // auth (re-export so the screen can render a login affordance if needed)
    isAuthenticated,
    refreshAuthState: auth.refreshAuthState,
  };
}
