import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { randomUUID } from 'expo-crypto';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { Climb } from '@boardsesh/shared-schema';
import { useMoonBoardCreateClimb } from '@boardsesh/create-climb-react';
import { useBoardProvider, isDuplicateClimbError } from '@boardsesh/board-react';
import {
  convertLitUpHoldsMapToMoonBoardHolds,
  encodeMoonBoardHoldsToFrames,
  MOONBOARD_ANGLES,
} from '@boardsesh/board-config';
import { GraphQLOperationError } from '@boardsesh/graphql-client';
import { useAuth } from '../../providers/auth-provider';
import { useProfile } from '../../lib/graphql/hooks';
import { useQueue } from '../../providers/queue-provider';
import { useOptionalBluetoothContext } from '../../providers/bluetooth-provider';
import { useToast } from '../../providers/toast-provider';
import { climbToQueueItem } from '../../lib/climb-to-queue-item';
import { loadDraft, saveDraft, clearDraft, createClimbDraftKey } from '../../lib/create-climb-draft-store';
import type { CreateClimbBoard, SaveButtonState } from './use-create-climb-screen';
import type { BrushRole } from './brush-roles';

type UseMoonBoardCreateScreenArgs = {
  board: CreateClimbBoard;
};

const AUTOSAVE_DEBOUNCE_MS = 500;
const BLE_PREVIEW_DEBOUNCE_MS = 250;
const JUST_SAVED_MS = 3000;

type MoonBoardAngle = (typeof MOONBOARD_ANGLES)[number];

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

/** Snap an arbitrary board angle to the nearest supported MoonBoard angle. */
function toMoonBoardAngle(angle: number): MoonBoardAngle {
  return MOONBOARD_ANGLES.includes(angle as MoonBoardAngle) ? (angle as MoonBoardAngle) : MOONBOARD_ANGLES[0];
}

/**
 * The MoonBoard create-climb controller. Parallels `useCreateClimbScreen` but
 * for MoonBoard's divergent flow: create-only (no in-place update), only
 * Start/Hand/Finish roles (no foot), grade/benchmark/angle fields, and a save
 * that ships a holds object (`{start,hand,finish}` grid coords) rather than an
 * Aurora frames string. Reuses the per-board local autosave and the queue
 * Set-Active path (frames via `encodeMoonBoardHoldsToFrames`).
 */
export function useMoonBoardCreateScreen({ board }: UseMoonBoardCreateScreenArgs) {
  const router = useRouter();
  const { t } = useTranslation('climbs');
  const { isAuthenticated, saveMoonBoardClimb } = useBoardProvider();
  const auth = useAuth();
  const { data: profile } = useProfile();
  const { setCurrentClimb } = useQueue();
  const bluetooth = useOptionalBluetoothContext();
  const { showToast } = useToast();

  const {
    litUpHoldsMap,
    setHoldState,
    startingCount,
    finishCount,
    isValid,
    resetHolds,
    setLitUpHoldsMap,
    undo,
    redo,
    canUndo,
    canRedo,
  } = useMoonBoardCreateClimb();

  const [selectedBrush, setSelectedBrush] = useState<BrushRole>('HAND');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isDraft, setIsDraft] = useState(true);
  const [showAllHolds, setShowAllHolds] = useState(false);
  // MoonBoard-only fields.
  const [angle, setAngle] = useState<MoonBoardAngle>(() => toMoonBoardAngle(board.angle));
  const [userGrade, setUserGrade] = useState<string | undefined>(undefined);
  const [isBenchmark, setIsBenchmark] = useState(false);

  const [savedUuid, setSavedUuid] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [publishDuplicateError, setPublishDuplicateError] = useState<PublishDuplicateError | null>(null);

  // One WIP per board config. MoonBoard holds are angle-independent and the
  // draft doesn't store the chosen angle, so key by the stable route config
  // (like Aurora) — keying on the mutable angle would clobber the draft when
  // the user switches 25<->40 in settings.
  const draftKey = useMemo(() => createClimbDraftKey(board), [board]);
  const restoredRef = useRef(false);
  const previewUuidRef = useRef<string | null>(null);
  if (!previewUuidRef.current) previewUuidRef.current = randomUUID();
  const justSavedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (justSavedTimerRef.current) clearTimeout(justSavedTimerRef.current);
    },
    [],
  );

  // ---- Local autosave restore on mount. ----
  useEffect(() => {
    let cancelled = false;
    void loadDraft(draftKey).then((draft) => {
      if (cancelled || !draft) {
        restoredRef.current = true;
        return;
      }
      try {
        const parsed = JSON.parse(draft.holdsJson) as Parameters<typeof setLitUpHoldsMap>[0];
        setLitUpHoldsMap(parsed);
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

  // ---- Frames (for BLE preview + Set-Active queue item). ----
  const generateFramesString = useCallback(() => {
    return encodeMoonBoardHoldsToFrames(convertLitUpHoldsMapToMoonBoardHolds(litUpHoldsMap));
  }, [litUpHoldsMap]);

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
    setSavedUuid(null);
    setPublishDuplicateError(null);
    previewUuidRef.current = randomUUID();
    void clearDraft(draftKey);
  }, [resetHolds, draftKey]);

  // Minimal Climb the queue can hold for a not-yet-saved or just-saved climb.
  const buildProvisionalClimb = useCallback(
    (uuid: string, frames: string): Climb => ({
      uuid,
      name: name.trim() || t('createClimbForm.draftBadge'),
      frames,
      setter_username: profile?.displayName ?? '',
      angle,
      ascensionist_count: 0,
      difficulty: '',
      quality_average: '0',
      stars: 0,
      difficulty_error: '0',
      benchmark_difficulty: null,
    }),
    [name, profile, angle, t],
  );

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
    const uuid = savedUuid ?? previewUuidRef.current ?? randomUUID();
    setCurrentClimb(climbToQueueItem(buildProvisionalClimb(uuid, frames), { uuid }));
  }, [generateFramesString, savedUuid, buildProvisionalClimb, setCurrentClimb]);

  // ---- BLE toggle (drives the drawer header lightbulb). ----
  const handleToggleBle = useCallback(() => {
    if (!bluetooth) return;
    if (bluetooth.isConnected) void bluetooth.disconnect();
    else void bluetooth.connect(generateFramesString());
  }, [bluetooth, generateFramesString]);

  // ---- Save state machine (no edit-lock: MoonBoard is create-only). ----
  const saveState: SaveButtonState = useMemo(() => {
    if (!isAuthenticated) return 'login';
    if (isSaving) return 'saving';
    if (justSaved) return 'justSaved';
    return 'ready';
  }, [isAuthenticated, isSaving, justSaved]);

  // Signal the drawer header should focus the name field on an unnamed save.
  const [focusNameSignal, setFocusNameSignal] = useState(0);
  const requestFocusName = useCallback(() => setFocusNameSignal((value) => value + 1), []);

  const handleSave = useCallback(async () => {
    if (!isAuthenticated) {
      router.push('/auth/login');
      return;
    }
    // Drafts may be incomplete; publishing needs >=1 start AND >=1 finish.
    if (!isDraft && !isValid) {
      showToast(t('mobile.create.moonboard.invalidPublish'), 'error');
      return;
    }
    if (name.trim() === '') {
      requestFocusName();
      return;
    }

    setIsSaving(true);
    setPublishDuplicateError(null);
    const holds = convertLitUpHoldsMapToMoonBoardHolds(litUpHoldsMap);
    const frames = generateFramesString();
    try {
      const result = await saveMoonBoardClimb({
        layoutId: board.layoutId,
        name: name.trim(),
        description,
        holds,
        angle,
        isDraft,
        userGrade,
        isBenchmark,
      });
      setSavedUuid(result.uuid);
      syncSavedToQueue(result.uuid, frames);
      await clearDraft(draftKey);
      setJustSaved(true);
      showToast(isDraft ? t('mobile.create.save.draftToast') : t('mobile.create.save.publishedToast'), 'success');
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
    isDraft,
    isValid,
    name,
    litUpHoldsMap,
    generateFramesString,
    saveMoonBoardClimb,
    board.layoutId,
    description,
    angle,
    userGrade,
    isBenchmark,
    draftKey,
    requestFocusName,
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
    // moonboard fields
    angle,
    setAngle,
    userGrade,
    setUserGrade,
    isBenchmark,
    setIsBenchmark,
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
    // auth
    isAuthenticated,
    refreshAuthState: auth.refreshAuthState,
  };
}
