'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import MuiAlert from '@mui/material/Alert';
import MuiTooltip from '@mui/material/Tooltip';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import IconButton from '@mui/material/IconButton';
import MuiButton from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import CircularProgress from '@mui/material/CircularProgress';
import MuiSwitch from '@mui/material/Switch';
import MuiSelect from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import Badge from '@mui/material/Badge';
import {
  SettingsOutlined,
  LocalFireDepartmentOutlined,
  SaveOutlined,
  LoginOutlined,
  CloudUploadOutlined,
  GetAppOutlined,
  DraftsOutlined,
  DeleteOutlined,
  CheckCircleOutlined,
  LockOutlined,
  PlayCircleOutlineOutlined,
} from '@mui/icons-material';
import { themeTokens } from '@/app/theme/theme-config';
import HoldIndicator from './hold-indicator';
import { usePathname } from 'next/navigation';
import LocaleLink from '@/app/components/i18n/locale-link';
import { track } from '@/app/lib/analytics';
import { useSession } from 'next-auth/react';
import BoardRenderer from '../board-renderer/board-renderer';
import MoonBoardRenderer from '../moonboard-renderer/moonboard-renderer';
import ZoomableBoard from '../board-renderer/zoomable-board';
import SwipeableDrawer from '../swipeable-drawer/swipeable-drawer';
import { useBoardProvider } from '../board-provider/board-provider-context';
import { useCreateClimb } from '@boardsesh/create-climb-react';
import { useMoonBoardCreateClimb } from './use-moonboard-create-climb';
import { useOptionalBluetoothContext } from '../board-bluetooth-control/bluetooth-context';
import type { MoonBoardClimbDuplicateMatch, UpdateClimbInput } from '@boardsesh/shared-schema';
import { CLIMB_CHARACTERISTICS } from '@boardsesh/shared-schema';
import type { BoardDetails, BoardName, Climb } from '@/app/lib/types';
import { convertLitUpHoldsStringToMap } from '../board-renderer/util';
import type { LitUpHoldsMap } from '../board-renderer/types';
import { getMoonBoardGradeLabel, MOONBOARD_GRADES, MOONBOARD_ANGLES } from '@/app/lib/moonboard-config';
import { getSoftGradeColor } from '@/app/lib/grade-colors';
import { useColorMode } from '@/app/hooks/use-color-mode';
import { parseScreenshot } from '@boardsesh/moonboard-ocr/browser';
import { convertOcrHoldsToMap } from '@/app/lib/moonboard-climbs-db';
import { createGraphQLClient, execute, GraphQLOperationError, type Client } from '../graphql-queue/graphql-client';
import SimilarClimbsList from '@/app/components/similar-climbs/similar-climbs-list';
import { getBackendWsUrl } from '@/app/lib/backend-url';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { useAuthModal } from '@/app/components/providers/auth-modal-provider';
import { useSnackbar } from '../providers/snackbar-provider';
import { useOptionalQueueActions, useOptionalCurrentClimb } from '@/app/components/graphql-queue';
import { refreshClimbSearchAfterSave } from '@/app/lib/climb-search-cache';
import { ConfirmPopover } from '@/app/components/ui/confirm-popover';
import { saveAutosave, loadAutosave, clearAutosave } from '@/app/lib/create-climb-autosave-db';
import { useDebouncedValue } from '@/app/hooks/use-debounced-value';
import CreateClimbHeatmapOverlay from './create-climb-heatmap-overlay';
import DraftsDrawer from './drafts-drawer';
import HoldTypePicker from './hold-type-picker';
import { useHoldTypePicker } from './use-hold-type-picker';
import ClimbTitle, { type ClimbTitleData } from '../climb-card/climb-title';
import {
  SEARCH_CLIMBS_COUNT,
  type ClimbSearchCountResponse,
  type ClimbSearchInputVariables,
} from '@boardsesh/graphql/operations/climb-search';
import { convertLitUpHoldsMapToMoonBoardHolds } from '@/app/lib/moonboard-climb-helpers';
import styles from './create-climb-form.module.css';
import {
  CHECK_MOONBOARD_CLIMB_DUPLICATES_QUERY,
  type CheckMoonBoardClimbDuplicatesResponse,
  type CheckMoonBoardClimbDuplicatesVariables,
  SAVE_MOONBOARD_CLIMB_MUTATION,
  type SaveMoonBoardClimbMutationVariables,
  type SaveMoonBoardClimbMutationResponse,
} from '@boardsesh/graphql/operations/new-climb-feed';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';

// The three mutually-exclusive MoonBoard method tokens (the create form's
// selectable methods). The "feet follow hands" default is the empty selection.
type MoonBoardMethodToken =
  | typeof CLIMB_CHARACTERISTICS.METHOD_FOOTLESS
  | typeof CLIMB_CHARACTERISTICS.METHOD_FOOTLESS_KICKBOARD
  | typeof CLIMB_CHARACTERISTICS.METHOD_NO_KICKBOARD;

const SETTINGS_DRAWER_STYLES = {
  wrapper: { height: 'auto', maxHeight: '70vh' },
  body: { padding: 0 },
};

type CreateClimbFormValues = {
  name: string;
  description: string;
  isDraft: boolean;
};

type BoardType = 'aurora' | 'moonboard';

type CreateClimbFormProps = {
  boardType: BoardType;
  angle: number;
  // Aurora-specific
  boardDetails?: BoardDetails;
  forkFrames?: string;
  forkName?: string;
  forkDescription?: string;
  // Pre-loaded climb to edit (Aurora only, for now). When present the form
  // seeds its hold map, name, description, and saved-row tracker from this
  // climb on mount so the user can pick up a draft or recent publish via URL.
  editClimb?: Climb;
  // Surfaces an inline error when an editClimbUuid was supplied but the
  // lookup failed (wrong board, deleted row, etc). Shown once on mount so
  // the user isn't left staring at an empty form wondering what happened.
  editClimbError?: string;
  // MoonBoard-specific
  layoutFolder?: string;
  layoutId?: number;
  holdSetImages?: string[];
};

const EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

export default function CreateClimbForm({
  boardType,
  angle,
  boardDetails,
  forkFrames,
  forkName,
  forkDescription,
  editClimb,
  editClimbError,
  layoutFolder,
  layoutId,
  holdSetImages,
}: CreateClimbFormProps) {
  const { t } = useTranslation('climbs');
  const { t: tCommon } = useTranslation('common');
  const pathname = usePathname();
  const { data: session } = useSession();
  const { mode } = useColorMode();
  const isDark = mode === 'dark';
  const queryClient = useQueryClient();

  // Aurora-specific hooks
  const { isAuthenticated, saveClimb, updateClimb } = useBoardProvider();
  const { showMessage } = useSnackbar();
  const { token: wsAuthToken } = useWsAuthToken();

  // Determine which auth check to use based on board type
  const isLoggedIn = boardType === 'aurora' ? isAuthenticated : !!session?.user?.id;
  const hasMoonBoardSessionUser = !!session?.user;

  // Convert fork frames to initial holds map if provided (Aurora only)
  const initialHoldsMap = useMemo(() => {
    if (boardType !== 'aurora' || !forkFrames || !boardDetails) return undefined;
    const framesMap = convertLitUpHoldsStringToMap(forkFrames, boardDetails.board_name);
    return framesMap[0] ?? undefined;
  }, [boardType, forkFrames, boardDetails]);

  // Aurora hold management
  const auroraClimb = useCreateClimb(boardDetails?.board_name || 'kilter', { initialHoldsMap });

  // MoonBoard hold management
  const moonboardClimb = useMoonBoardCreateClimb();

  // Use the appropriate hook values based on board type
  const {
    litUpHoldsMap,
    setHoldState,
    startingCount,
    finishCount,
    totalHolds,
    isValid,
    resetHolds: baseResetHolds,
  } = boardType === 'aurora' ? auroraClimb : moonboardClimb;

  const handCount = boardType === 'moonboard' ? moonboardClimb.handCount : 0;
  const generateFramesString = boardType === 'aurora' ? auroraClimb.generateFramesString : undefined;
  const setLitUpHoldsMap = boardType === 'moonboard' ? moonboardClimb.setLitUpHoldsMap : undefined;
  const loadAuroraHolds = boardType === 'aurora' ? auroraClimb.loadHolds : undefined;

  // Bluetooth for Aurora boards. Share the single root-level connection (the
  // one the lightbulb actually drives) instead of spinning up a second adapter
  // that nothing ever connects. Optional so the form still renders in isolated
  // unit tests that don't mount a BluetoothProvider.
  const bluetooth = useOptionalBluetoothContext();
  const isConnected = bluetooth?.isConnected ?? false;
  const sendFramesToBoard = bluetooth?.sendFramesToBoard;

  // Refs
  const fileInputRef = useRef<HTMLInputElement>(null);
  const graphqlClientRef = useRef<Client | null>(null);

  // Form state
  const [isSaving, setIsSaving] = useState(false);
  // Set to true briefly after a successful save so the Save button flips to a
  // "Saved" confirmation state for both draft and published saves.
  const [justSaved, setJustSaved] = useState(false);
  const savedTimeoutRef = useRef<number | null>(null);
  const { openAuthModal } = useAuthModal();
  const [pendingFormValues, setPendingFormValues] = useState<CreateClimbFormValues | null>(null);

  // Tracks the row we've saved during this form session so subsequent Save
  // presses update that row in place instead of creating a new climb. Cleared
  // by Clear. Set by both create (saveClimb) and load-a-draft flows.
  type SavedClimbState = {
    uuid: string;
    boardType: string;
    /** ISO timestamp of when the row was created */
    createdAt: string | null;
    /** ISO timestamp of when the row was first published; null while still draft */
    publishedAt: string | null;
    isDraft: boolean;
  };
  const [savedClimb, setSavedClimb] = useState<SavedClimbState | null>(null);

  // Tracks the uuid of the queue item representing the climb the user is
  // authoring. Set when the climb first lands in the queue (first save or
  // drafts-drawer load) and reused on subsequent saves to replace the same
  // queue slot in place instead of piling up duplicates. Cleared by Clear.
  const [queueItemUuid, setQueueItemUuid] = useState<string | null>(null);

  // The create page is always mounted inside GraphQLQueueProvider, but use the
  // optional hook so unit tests that render the form in isolation don't blow up.
  const queueActions = useOptionalQueueActions();
  const currentClimbData = useOptionalCurrentClimb();

  // Stable UUID for preview climbs pushed to the queue before saving. This
  // ensures repeated "Set Active" presses update the same queue slot.
  const previewUuidRef = useRef<string | null>(null);
  const getPreviewUuid = useCallback(() => {
    if (!previewUuidRef.current) {
      // crypto.randomUUID() is unavailable in older Safari / non-secure contexts
      previewUuidRef.current =
        typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    return previewUuidRef.current;
  }, []);

  const markJustSaved = useCallback(() => {
    setJustSaved(true);
    autosaveSuppressedRef.current = true;
    // A successful save clears any prior duplicate-publish error. The
    // useEffect on litUpHoldsMap / isDraft already covers the "user changed
    // a hold" path; this catches the metadata-only-retry case where the
    // user fixed the conflict by re-saving without touching holds or the
    // draft flag (e.g. server-side state changed in the meantime).
    setPublishDuplicateError(null);
    void clearAutosave();
    if (savedTimeoutRef.current !== null) {
      window.clearTimeout(savedTimeoutRef.current);
    }
    savedTimeoutRef.current = window.setTimeout(() => {
      setJustSaved(false);
      savedTimeoutRef.current = null;
    }, 3000);
  }, []);

  const clearJustSaved = useCallback(() => {
    setJustSaved(false);
    if (savedTimeoutRef.current !== null) {
      window.clearTimeout(savedTimeoutRef.current);
      savedTimeoutRef.current = null;
    }
  }, []);

  // Clear the timer on unmount so we don't touch state after the form is gone.
  useEffect(() => {
    return () => {
      if (savedTimeoutRef.current !== null) {
        window.clearTimeout(savedTimeoutRef.current);
      }
    };
  }, []);

  // Published climbs remain editable for 24 hours after their first publish.
  // Drafts are editable indefinitely. We re-check on every render so the lock
  // naturally engages while the form is open past the window.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!savedClimb?.publishedAt) return;
    const publishedMs = Date.parse(savedClimb.publishedAt);
    if (!Number.isFinite(publishedMs)) return;
    const remaining = publishedMs + EDIT_WINDOW_MS - Date.now();
    if (remaining <= 0) {
      setNowTick(Date.now());
      return;
    }
    // Tick once when the edit window expires so the button flips to locked.
    const timeoutId = window.setTimeout(() => setNowTick(Date.now()), remaining + 50);
    return () => window.clearTimeout(timeoutId);
  }, [savedClimb?.publishedAt]);

  const editLocked = useMemo(() => {
    if (!savedClimb) return false;
    if (savedClimb.isDraft) return false; // drafts are always editable
    if (!savedClimb.publishedAt) return false;
    const publishedMs = Date.parse(savedClimb.publishedAt);
    if (!Number.isFinite(publishedMs)) return false;
    return nowTick - publishedMs > EDIT_WINDOW_MS;
  }, [savedClimb, nowTick]);

  // Aurora-specific state
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [isHeatmapLoading, setIsHeatmapLoading] = useState(false);
  const heatmapOpacity = 0.7;
  const handleHeatmapLoadingChange = useCallback((loading: boolean) => setIsHeatmapLoading(loading), []);
  const [isDraft, setIsDraft] = useState(true);

  // MoonBoard-specific state
  const [isOcrProcessing, setIsOcrProcessing] = useState(false);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [ocrWarnings, setOcrWarnings] = useState<string[]>([]);
  const [userGrade, setUserGrade] = useState<string | undefined>(undefined);
  const [isBenchmark, setIsBenchmark] = useState(false);
  // MoonBoard method as a characteristic token; '' = the "feet follow hands" default.
  const [method, setMethod] = useState<MoonBoardMethodToken | ''>('');
  const userGradeLabel = useMemo(() => (userGrade ? getMoonBoardGradeLabel(userGrade) : undefined), [userGrade]);
  const [selectedAngle, setSelectedAngle] = useState<number>(angle);
  const [moonBoardDuplicateMatch, setMoonBoardDuplicateMatch] = useState<MoonBoardClimbDuplicateMatch | null>(null);
  const [isCheckingMoonBoardDuplicate, setIsCheckingMoonBoardDuplicate] = useState(false);
  // Set when a publish attempt is rejected by the server because the holds
  // exactly match an existing climb. We surface an inline Alert + a drawer
  // that shows the matching climb via the SimilarClimbsList component.
  // `target` says how to drive the list — by frames (Aurora) or by the
  // existing climb's uuid (MoonBoard, where we don't compose frames locally).
  // `target` is what drives the SimilarClimbsList drawer. It's optional —
  // if the backend's CLIMB_IS_DUPLICATE error didn't carry an existing-climb
  // uuid AND we can't compose a frames string on the client (today: MoonBoard
  // without a uuid in the extension), the inline error still renders but the
  // "View matching climb" button hides. Avoids sending an empty `frames` to
  // the server, which would fail SimilarClimbsInputSchema's min(1) check.
  const [publishDuplicateError, setPublishDuplicateError] = useState<{
    existingClimbUuid: string | null;
    existingClimbName: string | null;
    target: { kind: 'frames'; frames: string } | { kind: 'climbUuid'; climbUuid: string } | null;
  } | null>(null);
  const [showDuplicateMatchDrawer, setShowDuplicateMatchDrawer] = useState(false);

  // Common state — in edit mode use the original name, not "{name} remix"
  const isEditMode = !!editClimb;
  let initialClimbName: string;
  if (isEditMode) {
    initialClimbName = forkName || '';
  } else if (forkName) {
    initialClimbName = `${forkName} remix`;
  } else {
    initialClimbName = '';
  }
  const [climbName, setClimbName] = useState(initialClimbName);
  const [description, setDescription] = useState(forkDescription || '');
  const [showSettingsPanel, setShowSettingsPanel] = useState(false);
  const [showDraftsDrawer, setShowDraftsDrawer] = useState(false);
  const zoomResetKey = boardType === 'moonboard' ? `moonboard-${selectedAngle}` : `aurora-${angle}`;
  const duplicateCheckRequestIdRef = useRef(0);

  // Construct the bulk import URL (MoonBoard only)
  const bulkImportUrl = pathname.replace(/\/create$/, '/import');

  // Autosave: persist form state to IndexedDB on every change (debounced).
  // Only one autosave is stored at a time, scoped to the current board.
  const autosaveBoardKey =
    boardType === 'aurora' && boardDetails
      ? `${boardDetails.board_name}:${boardDetails.layout_id}:${boardDetails.size_id}:${angle}`
      : `moonboard:${layoutId}:${angle}`;
  const autosaveRestoredRef = useRef(false);
  const autosaveSuppressedRef = useRef(false);

  // Restore autosave on mount (only if not forking).
  // Mark restored only after the async load completes to prevent the
  // debounced autosave effect from clearing the stored draft before it
  // has been read.
  useEffect(() => {
    if (autosaveRestoredRef.current || forkFrames || forkName) {
      autosaveRestoredRef.current = true;
      return;
    }
    let cancelled = false;
    void loadAutosave(autosaveBoardKey).then((saved) => {
      if (cancelled) return;
      if (saved) {
        try {
          const holds = JSON.parse(saved.holdsJson);
          if (boardType === 'aurora' && loadAuroraHolds) {
            loadAuroraHolds(holds);
          } else if (boardType === 'moonboard' && setLitUpHoldsMap) {
            setLitUpHoldsMap(holds);
          }
          if (saved.climbName) setClimbName(saved.climbName);
          if (saved.description) setDescription(saved.description);
          setIsDraft(saved.isDraft);
        } catch {
          void clearAutosave();
        }
      }
      autosaveRestoredRef.current = true;
    });
    return () => {
      cancelled = true;
    };
    // Only run on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced autosave on changes
  const autosaveData = useMemo(
    () => ({
      holdsJson: JSON.stringify(litUpHoldsMap),
      climbName,
      description,
      isDraft,
      boardKey: autosaveBoardKey,
    }),
    [litUpHoldsMap, climbName, description, isDraft, autosaveBoardKey],
  );
  const debouncedAutosave = useDebouncedValue(autosaveData, 500);
  const debouncedTotalHolds = useDebouncedValue(totalHolds, 500);

  useEffect(() => {
    if (!autosaveRestoredRef.current) return;
    if (autosaveSuppressedRef.current) {
      autosaveSuppressedRef.current = false;
      return;
    }
    if (debouncedTotalHolds === 0 && !debouncedAutosave.climbName && !debouncedAutosave.description) {
      void clearAutosave();
      return;
    }
    void saveAutosave(debouncedAutosave);
  }, [debouncedAutosave, debouncedTotalHolds]);

  const moonBoardHolds = useMemo(
    () => (boardType === 'moonboard' ? convertLitUpHoldsMapToMoonBoardHolds(litUpHoldsMap) : null),
    [boardType, litUpHoldsMap],
  );

  const moonBoardDuplicateError = useMemo(() => {
    if (!moonBoardDuplicateMatch?.exists) return null;
    return moonBoardDuplicateMatch.existingClimbName
      ? `This hold pattern already exists as "${moonBoardDuplicateMatch.existingClimbName}". Change at least one hold to save.`
      : 'This hold pattern already exists. Change at least one hold to save.';
  }, [moonBoardDuplicateMatch]);

  // Live board preview while BUILDING: push raw frames to the shared connection
  // on every hold edit. Only while the climb isn't in the queue yet
  // (queueItemUuid == null) — once it's been Set Active / saved, the queue's
  // replaceQueueItem → BluetoothAutoSender path owns the wall, so sending here
  // too would double-write. Local-only (no WS broadcast), matching the pivot's
  // "building doesn't broadcast" rule.
  useEffect(() => {
    if (queueItemUuid != null) return;
    if (boardType === 'aurora' && isConnected && generateFramesString) {
      void sendFramesToBoard?.(generateFramesString());
    }
  }, [boardType, litUpHoldsMap, isConnected, generateFramesString, sendFramesToBoard, queueItemUuid]);

  // As soon as the user edits the climb after a successful save, flip the
  // button back to its normal "Save" state so they can save the revision.
  useEffect(() => {
    if (justSaved) {
      clearJustSaved();
    }
    // We intentionally depend only on the edit signals, not on justSaved
    // itself — otherwise this effect would re-run every time we clear the flag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [climbName, description, litUpHoldsMap]);

  // Clear the publish duplicate error when the user changes anything that
  // could resolve it — toggling isDraft (the suggested escape hatch) or
  // changing the hold pattern. We snapshot the holds (and isDraft) at the
  // moment the error is set so async hold-map updates that happen *after*
  // the error (e.g. autosave restore on a remount, a bluetooth state echo)
  // don't wipe the error before the user has actually edited anything.
  // Comparison is content-based — litUpHoldsMap can churn its object
  // identity without contents changing.
  const errorSnapshotRef = useRef<{ holdsJson: string; isDraft: boolean } | null>(null);
  useEffect(() => {
    if (!publishDuplicateError) {
      errorSnapshotRef.current = null;
      setShowDuplicateMatchDrawer(false);
      return;
    }
    if (errorSnapshotRef.current === null) {
      errorSnapshotRef.current = { holdsJson: JSON.stringify(litUpHoldsMap), isDraft };
      return;
    }
    const currentHoldsJson = JSON.stringify(litUpHoldsMap);
    if (currentHoldsJson !== errorSnapshotRef.current.holdsJson || isDraft !== errorSnapshotRef.current.isDraft) {
      setPublishDuplicateError(null);
    }
  }, [publishDuplicateError, litUpHoldsMap, isDraft]);

  // The SimilarClimbsList needs the active board+layout to scope its query.
  // Aurora reads from boardDetails; MoonBoard reads from the layoutId prop.
  // Both stay null when their source isn't ready — render path below hides
  // the drawer rather than silently defaulting to a wrong board (a Tension
  // user shouldn't see Kilter results because boardDetails hadn't loaded
  // by the time the publish attempt threw).
  const duplicateMatchBoardName: BoardName | null =
    boardType === 'aurora' ? ((boardDetails?.board_name as BoardName | undefined) ?? null) : 'moonboard';
  const duplicateMatchLayoutId: number | null =
    boardType === 'aurora' ? (boardDetails?.layout_id ?? null) : (layoutId ?? null);

  // Hold-type picker: tracks which hold the user just tapped, anchors the
  // popover against its DOM element, and routes selections back to setHoldState.
  const picker = useHoldTypePicker({ litUpHoldsMap, setHoldState });
  const pickerBoardName = boardType === 'aurora' ? (boardDetails?.board_name ?? 'kilter') : 'moonboard';

  // Wrap resetHolds so Clear starts a brand-new climb: holds wiped, text fields
  // cleared, Bluetooth board blanked, any lingering "Saved" confirmation
  // dismissed, and the tracked savedClimb row detached so the next Save
  // creates a new climb instead of updating the previous one.
  // Leaves the Draft toggle alone — that's a user preference.
  const resetHolds = useCallback(() => {
    baseResetHolds();
    setClimbName('');
    setDescription('');
    clearJustSaved();
    autosaveSuppressedRef.current = true;
    void clearAutosave();
    setSavedClimb(null);
    // Detach the tracked queue slot too — Clear starts a fresh climb, so the
    // next Save should create a new queue item rather than replace the old one.
    // The existing queue item is intentionally left in place; Clear resets the
    // form, not party state.
    setQueueItemUuid(null);
    if (boardType === 'aurora' && isConnected) {
      void sendFramesToBoard?.('');
    }
    if (boardType === 'moonboard') {
      setUserGrade(undefined);
      setIsBenchmark(false);
      setMethod('');
      setOcrError(null);
      setOcrWarnings([]);
      setMoonBoardDuplicateMatch(null);
    }
  }, [boardType, baseResetHolds, isConnected, sendFramesToBoard, clearJustSaved]);

  // MoonBoard OCR import
  const handleOcrImport = useCallback(
    async (file: File) => {
      if (boardType !== 'moonboard' || !setLitUpHoldsMap) return;

      setIsOcrProcessing(true);
      setOcrError(null);
      setOcrWarnings([]);

      try {
        const result = await parseScreenshot(file);

        if (!result.success || !result.climb) {
          setOcrError(result.error || 'Failed to parse screenshot');
          return;
        }

        const climb = result.climb;
        const warnings = [...result.warnings];

        // Check angle mismatch
        if (climb.angle !== angle) {
          warnings.push(`Screenshot is for ${climb.angle}° but current page is ${angle}°. Holds imported anyway.`);
        }

        setOcrWarnings(warnings);

        // Convert OCR holds to form state
        const newHoldsMap = convertOcrHoldsToMap(climb.holds);
        setLitUpHoldsMap(newHoldsMap);

        // Populate fields from OCR
        if (climb.name) setClimbName(climb.name);
        if (climb.userGrade) setUserGrade(climb.userGrade);
        if (climb.isBenchmark) setIsBenchmark(true);
        if (climb.setter) setDescription(`Setter: ${climb.setter}`);
      } catch (error) {
        setOcrError(error instanceof Error ? error.message : 'Unknown error during OCR');
      } finally {
        setIsOcrProcessing(false);
      }
    },
    [boardType, angle, setLitUpHoldsMap],
  );

  const runMoonBoardDuplicateCheck = useCallback(
    async (holds: NonNullable<typeof moonBoardHolds>) => {
      if (!layoutId) return null;

      const requestId = ++duplicateCheckRequestIdRef.current;
      setIsCheckingMoonBoardDuplicate(true);

      try {
        const client = createGraphQLHttpClient();
        const variables: CheckMoonBoardClimbDuplicatesVariables = {
          input: {
            layoutId,
            angle: selectedAngle,
            climbs: [{ clientKey: 'create-form', holds }],
          },
        };

        const response = await client.request<
          CheckMoonBoardClimbDuplicatesResponse,
          CheckMoonBoardClimbDuplicatesVariables
        >(CHECK_MOONBOARD_CLIMB_DUPLICATES_QUERY, variables);
        const duplicateMatch = response.checkMoonBoardClimbDuplicates[0] ?? null;

        if (requestId === duplicateCheckRequestIdRef.current) {
          setMoonBoardDuplicateMatch(duplicateMatch?.exists ? duplicateMatch : null);
        }

        return duplicateMatch?.exists ? duplicateMatch : null;
      } catch (error) {
        console.warn('Failed to check MoonBoard climb duplicates:', error);

        if (requestId === duplicateCheckRequestIdRef.current) {
          setMoonBoardDuplicateMatch(null);
        }

        return null;
      } finally {
        if (requestId === duplicateCheckRequestIdRef.current) {
          setIsCheckingMoonBoardDuplicate(false);
        }
      }
    },
    [layoutId, selectedAngle],
  );

  useEffect(() => {
    if (boardType !== 'moonboard') {
      setMoonBoardDuplicateMatch(null);
      setIsCheckingMoonBoardDuplicate(false);
      return;
    }

    if (!layoutId || !moonBoardHolds || !isValid) {
      duplicateCheckRequestIdRef.current += 1;
      setMoonBoardDuplicateMatch(null);
      setIsCheckingMoonBoardDuplicate(false);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void runMoonBoardDuplicateCheck(moonBoardHolds);
    }, 350);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [boardType, isValid, layoutId, moonBoardHolds, runMoonBoardDuplicateCheck, selectedAngle]);

  // Builds a Climb object from the form's current state + a freshly-issued
  // uuid. Used to push the in-progress climb into the live queue so party
  // peers and a connected Bluetooth board see it as the current climb. Fields
  // the form doesn't own (difficulty, stars, ascents, etc.) get safe defaults
  // — a brand-new draft has nothing to report for those.
  const buildClimbFromFormState = useCallback(
    (uuid: string, frames: string): Climb => {
      // Stamp publish time on the first save that flips out of draft. Drafts
      // leave this null; once published it stays stable until the 24h window
      // lapses and the backend refuses further updates.
      let publishedAt: string | null;
      if (isDraft) {
        publishedAt = null;
      } else if (savedClimb?.publishedAt) {
        publishedAt = savedClimb.publishedAt;
      } else {
        publishedAt = new Date().toISOString();
      }
      return {
        uuid,
        name: climbName,
        description,
        frames,
        angle: boardType === 'moonboard' ? selectedAngle : angle,
        setter_username: session?.user?.name || '',
        // Stable owner identity. The queue list (local + peers) uses this —
        // not setter_username — to decide whether to show the Edit button,
        // because usernames can change or be blank but userId is immutable.
        userId: session?.user?.id ?? null,
        ascensionist_count: 0,
        difficulty: '',
        quality_average: '0',
        stars: 0,
        difficulty_error: '0',
        benchmark_difficulty: null,
        mirrored: false,
        is_draft: isDraft,
        published_at: publishedAt,
        layoutId: boardType === 'aurora' ? (boardDetails?.layout_id ?? null) : (layoutId ?? null),
        boardType: boardType === 'aurora' ? boardDetails?.board_name : 'moonboard',
      };
    },
    [
      climbName,
      description,
      angle,
      selectedAngle,
      boardType,
      session?.user?.name,
      session?.user?.id,
      isDraft,
      savedClimb?.publishedAt,
      boardDetails?.layout_id,
      boardDetails?.board_name,
      layoutId,
    ],
  );

  // Pushes the just-saved (or just-updated) climb into the live queue so it
  // becomes the current active climb. On first save we call setCurrentClimb
  // and remember the queue-item uuid; on subsequent saves we call
  // replaceQueueItem against that uuid so the queue slot stays stable.
  // BluetoothAutoSender reacts to currentClimbQueueItem identity changes and
  // pushes new frames to the board automatically, so party peers with a
  // connected board also see the update.
  const syncSavedClimbToQueue = useCallback(
    async (uuid: string, frames: string) => {
      if (!queueActions) return;
      const climb = buildClimbFromFormState(uuid, frames);
      if (queueItemUuid) {
        queueActions.replaceQueueItem(queueItemUuid, climb);
        return;
      }
      const newItem = await queueActions.setCurrentClimb(climb, { playlistSuggestionSource: null });
      if (newItem) {
        setQueueItemUuid(newItem.uuid);
      }
    },
    [queueActions, queueItemUuid, buildClimbFromFormState],
  );

  // Pushes the current WIP climb to the party queue without saving, so other
  // session members can see it on their screens. Uses the saved climb's UUID if
  // available, otherwise a stable preview UUID.
  const handleSetActive = useCallback(async () => {
    if (!queueActions) return;

    const uuid = savedClimb?.uuid ?? getPreviewUuid();
    const frames = boardType === 'aurora' && generateFramesString ? generateFramesString() : '';

    const climb = buildClimbFromFormState(uuid, frames);

    if (queueItemUuid) {
      queueActions.replaceQueueItem(queueItemUuid, climb);
    } else {
      const newItem = await queueActions.setCurrentClimb(climb, { playlistSuggestionSource: null });
      if (newItem) {
        setQueueItemUuid(newItem.uuid);
      }
    }

    track('Create Climb Set Active', {
      boardType,
      hasBeenSaved: !!savedClimb,
    });
  }, [
    queueActions,
    savedClimb,
    getPreviewUuid,
    boardType,
    generateFramesString,
    buildClimbFromFormState,
    queueItemUuid,
  ]);

  // Whether the current WIP climb is already the active climb in the queue.
  const isPreviewActive = useMemo(() => {
    if (!currentClimbData?.currentClimb) return false;
    const activeUuid = currentClimbData.currentClimb.uuid;
    return activeUuid === savedClimb?.uuid || activeUuid === previewUuidRef.current;
  }, [currentClimbData?.currentClimb, savedClimb?.uuid]);

  // Keep the queue item in sync with hold changes. Once a climb lands in the
  // queue (via Save or Set Active), every hold edit pushes an update so party
  // members see the latest layout in real time — same as Bluetooth above.
  useEffect(() => {
    if (!queueActions || !queueItemUuid) return;

    const uuid = savedClimb?.uuid ?? previewUuidRef.current;
    if (!uuid) return;

    const frames = boardType === 'aurora' && generateFramesString ? generateFramesString() : '';
    const climb = buildClimbFromFormState(uuid, frames);
    queueActions.replaceQueueItem(queueItemUuid, climb);
  }, [
    litUpHoldsMap,
    queueActions,
    queueItemUuid,
    savedClimb?.uuid,
    boardType,
    generateFramesString,
    buildClimbFromFormState,
  ]);

  // Save climb - Aurora
  //
  // Flow:
  //   - First press (no savedClimb yet): create a new row via saveClimb.
  //   - Subsequent press on the same row: update it in place via updateClimb.
  //     Drafts stay editable indefinitely; published climbs have a 24h window
  //     (enforced on the backend too).
  //
  // The form never navigates away on save anymore — the user stays on the
  // create page and the Save button flips to a transient "Saved" confirmation
  // state. Clearing the form (via Clear) detaches savedClimb so the next
  // save starts a fresh row.
  const doSaveAuroraClimb = useCallback(async () => {
    if (!boardDetails || !generateFramesString) return;

    setIsSaving(true);

    // Captured before the try/catch so the catch block can drive the
    // duplicate-resolution drawer off the exact frames we attempted to
    // save, rather than re-reading the form state (which the user may
    // have edited between the failure and the catch).
    const frames = generateFramesString();

    try {
      const invalidateDraftCaches = () =>
        Promise.all([
          queryClient.invalidateQueries({
            queryKey: ['climbDrafts', boardDetails.board_name, boardDetails.layout_id],
          }),
          queryClient.invalidateQueries({
            queryKey: ['climbDraftsCount', boardDetails.board_name, boardDetails.layout_id],
          }),
        ]);

      // Decide create-vs-update. We can only update when we have a savedClimb
      // for the current board type and its edit window is still open (for
      // drafts, the window is effectively infinite).
      const canUpdate =
        !!savedClimb &&
        savedClimb.boardType === boardDetails.board_name &&
        (savedClimb.isDraft ||
          (!!savedClimb.publishedAt && Date.now() - Date.parse(savedClimb.publishedAt) <= EDIT_WINDOW_MS));

      if (canUpdate && savedClimb) {
        const updateInput: UpdateClimbInput = {
          uuid: savedClimb.uuid,
          boardType: savedClimb.boardType,
          name: climbName,
          description: description || '',
          frames,
          angle,
          framesCount: 1,
          framesPace: 0,
          isDraft,
        };
        const updateResult = await updateClimb(updateInput);

        // A draft→published transition updates the published climb list too;
        // otherwise we just refresh the drafts cache either way so UI stays
        // in sync.
        if (savedClimb.isDraft && !updateResult.isDraft) {
          await refreshClimbSearchAfterSave(queryClient, boardDetails.board_name, boardDetails.layout_id);
        }
        await invalidateDraftCaches();

        setSavedClimb({
          uuid: updateResult.uuid,
          boardType: boardDetails.board_name,
          createdAt: updateResult.createdAt ?? savedClimb.createdAt,
          publishedAt: updateResult.publishedAt ?? null,
          isDraft: updateResult.isDraft,
        });

        track('Climb Updated', {
          boardLayout: boardDetails.layout_name || '',
          isDraft: updateResult.isDraft,
          holdCount: totalHolds,
        });

        if (process.env.NODE_ENV !== 'production') {
          console.info('[climb-update]', {
            uuid: updateResult.uuid,
            isDraft: updateResult.isDraft,
            publishedAt: updateResult.publishedAt,
          });
        }

        await syncSavedClimbToQueue(updateResult.uuid, frames);

        markJustSaved();
        return;
      }

      // Create a brand-new row.
      const saveResult = await saveClimb({
        layout_id: boardDetails.layout_id,
        name: climbName,
        description: description || '',
        is_draft: isDraft,
        frames,
        frames_count: 1,
        frames_pace: 0,
        angle,
      });

      if (!isDraft) {
        await refreshClimbSearchAfterSave(queryClient, boardDetails.board_name, boardDetails.layout_id);
      }
      await invalidateDraftCaches();

      track('Climb Created', {
        boardLayout: boardDetails.layout_name || '',
        isDraft: isDraft,
        holdCount: totalHolds,
      });

      setSavedClimb({
        uuid: saveResult.uuid,
        boardType: boardDetails.board_name,
        createdAt: saveResult.createdAt ?? null,
        publishedAt: saveResult.publishedAt ?? null,
        isDraft,
      });

      if (process.env.NODE_ENV !== 'production') {
        console.info('[climb-save]', {
          uuid: saveResult?.uuid,
          isDraft,
          publishedAt: saveResult?.publishedAt ?? null,
          boardType: boardDetails.board_name,
          layoutId: boardDetails.layout_id,
          sizeId: boardDetails.size_id,
          setIds: boardDetails.set_ids,
          angle,
        });
      }

      await syncSavedClimbToQueue(saveResult.uuid, frames);

      markJustSaved();
    } catch (error) {
      console.error('Failed to save climb:', error);
      track('Climb Create Failed', {
        boardLayout: boardDetails.layout_name || '',
      });
      if (error instanceof GraphQLOperationError && error.extensions?.code === 'CLIMB_IS_DUPLICATE') {
        setPublishDuplicateError({
          existingClimbUuid: error.extensions.existingClimbUuid ?? null,
          existingClimbName: error.extensions.existingClimbName ?? null,
          target: { kind: 'frames', frames },
        });
      } else {
        showMessage(error instanceof Error ? error.message : t('createClimbForm.alerts.saveFailedFallback'), 'error');
      }
    } finally {
      setIsSaving(false);
    }
  }, [
    boardDetails,
    generateFramesString,
    saveClimb,
    updateClimb,
    climbName,
    description,
    isDraft,
    angle,
    totalHolds,
    queryClient,
    markJustSaved,
    savedClimb,
    showMessage,
    syncSavedClimbToQueue,
    t,
  ]);

  // Save climb - MoonBoard
  //
  // Mirrors the Aurora flow: first Save creates a new row; subsequent Saves
  // update the tracked row in place (within the 24h post-publish window for
  // non-drafts). The form never navigates away on save.
  //
  // Note: MoonBoard hold re-encoding on update isn't supported by updateClimb,
  // so updates only touch name/description/angle/isDraft. If the user changes
  // holds after a save we intentionally skip the update and create a new row,
  // which the duplicate check will catch if the new holds collide.
  const doSaveMoonBoardClimb = useCallback(async () => {
    const userId = session?.user?.id;
    if (!layoutId || !userId || !moonBoardHolds) return;

    if (moonBoardDuplicateError) {
      showMessage(moonBoardDuplicateError, 'error');
      return;
    }

    setIsSaving(true);

    try {
      if (!wsAuthToken) {
        throw new Error('Authentication required to save climb');
      }

      const invalidateCaches = async (wasDraft: boolean) => {
        if (!wasDraft) {
          await refreshClimbSearchAfterSave(queryClient, 'moonboard', layoutId);
        }
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['climbDrafts', 'moonboard', layoutId] }),
          queryClient.invalidateQueries({ queryKey: ['climbDraftsCount', 'moonboard', layoutId] }),
        ]);
      };

      // Update path: we already have a savedClimb and its edit window is open.
      const canUpdate =
        !!savedClimb &&
        savedClimb.boardType === 'moonboard' &&
        (savedClimb.isDraft ||
          (!!savedClimb.publishedAt && Date.now() - Date.parse(savedClimb.publishedAt) <= EDIT_WINDOW_MS));

      if (canUpdate && savedClimb) {
        const updateInput: UpdateClimbInput = {
          uuid: savedClimb.uuid,
          boardType: 'moonboard',
          name: climbName,
          description: description || '',
          angle: selectedAngle,
          isDraft,
        };
        const updateResult = await updateClimb(updateInput);

        await invalidateCaches(savedClimb.isDraft);

        setSavedClimb({
          uuid: updateResult.uuid,
          boardType: 'moonboard',
          createdAt: updateResult.createdAt ?? savedClimb.createdAt,
          publishedAt: updateResult.publishedAt ?? null,
          isDraft: updateResult.isDraft,
        });

        if (process.env.NODE_ENV !== 'production') {
          console.info('[climb-update]', {
            uuid: updateResult.uuid,
            isDraft: updateResult.isDraft,
            publishedAt: updateResult.publishedAt,
            boardType: 'moonboard',
          });
        }

        // MoonBoard doesn't regenerate a frames string on update (updateClimb
        // only touches metadata), so reuse whatever the existing queue item
        // already has via an empty frames string — the queue renderer won't
        // use it for MoonBoard and the form's own hold map is authoritative.
        await syncSavedClimbToQueue(updateResult.uuid, '');

        markJustSaved();
        return;
      }

      if (!graphqlClientRef.current) {
        graphqlClientRef.current = createGraphQLClient({
          url: getBackendWsUrl()!,
          authToken: wsAuthToken,
        });
      }

      const variables: SaveMoonBoardClimbMutationVariables = {
        input: {
          boardType: 'moonboard',
          layoutId,
          name: climbName,
          description: description || '',
          holds: moonBoardHolds,
          angle: selectedAngle,
          isDraft: isDraft,
          userGrade,
          isBenchmark,
          method: method || undefined,
          setter: undefined,
        },
      };

      const moonBoardResult = await execute<SaveMoonBoardClimbMutationResponse, SaveMoonBoardClimbMutationVariables>(
        graphqlClientRef.current,
        { query: SAVE_MOONBOARD_CLIMB_MUTATION, variables },
      );

      await invalidateCaches(isDraft);

      setSavedClimb({
        uuid: moonBoardResult.saveMoonBoardClimb.uuid,
        boardType: 'moonboard',
        createdAt: moonBoardResult.saveMoonBoardClimb.createdAt ?? null,
        publishedAt: moonBoardResult.saveMoonBoardClimb.publishedAt ?? null,
        isDraft,
      });

      if (process.env.NODE_ENV !== 'production') {
        console.info('[climb-save]', {
          uuid: moonBoardResult?.saveMoonBoardClimb?.uuid,
          isDraft,
          publishedAt: moonBoardResult?.saveMoonBoardClimb?.publishedAt ?? null,
          boardType: 'moonboard',
          layoutId,
          angle: selectedAngle,
        });
      }

      await syncSavedClimbToQueue(moonBoardResult.saveMoonBoardClimb.uuid, '');

      markJustSaved();
    } catch (error) {
      console.error('Failed to save climb:', error);
      if (error instanceof GraphQLOperationError && error.extensions?.code === 'CLIMB_IS_DUPLICATE') {
        const existingClimbUuid = error.extensions.existingClimbUuid ?? null;
        setPublishDuplicateError({
          existingClimbUuid,
          existingClimbName: error.extensions.existingClimbName ?? null,
          // MoonBoard doesn't expose a canonical frames string on the client,
          // so drive the SimilarClimbsList off the existing climb's uuid.
          target: existingClimbUuid ? { kind: 'climbUuid', climbUuid: existingClimbUuid } : null,
        });
      } else {
        showMessage(error instanceof Error ? error.message : t('createClimbForm.alerts.saveFailedFallback'), 'error');
      }
    } finally {
      setIsSaving(false);
    }
  }, [
    layoutId,
    session,
    moonBoardHolds,
    moonBoardDuplicateError,
    climbName,
    description,
    userGrade,
    isBenchmark,
    method,
    isDraft,
    selectedAngle,
    wsAuthToken,
    queryClient,
    showMessage,
    markJustSaved,
    savedClimb,
    updateClimb,
    syncSavedClimbToQueue,
    t,
  ]);

  const handleAuthSuccess = useCallback(async () => {
    if (pendingFormValues) {
      setTimeout(async () => {
        setPendingFormValues(null);
      }, 1000);
    }
  }, [pendingFormValues]);

  const handlePublish = useCallback(async () => {
    if (!climbName.trim()) {
      return;
    }

    if (!isValid) {
      // MoonBoard: drafts are allowed to be incomplete; only block publish.
      if (boardType === 'moonboard') {
        if (!isDraft) {
          showMessage(t('createClimbForm.validation.needsStartFinish'), 'warning');
          return;
        }
      } else {
        return;
      }
    }

    if (boardType === 'moonboard' && (isCheckingMoonBoardDuplicate || moonBoardDuplicateError)) {
      if (moonBoardDuplicateError) {
        showMessage(moonBoardDuplicateError, 'error');
      }
      return;
    }

    if (!isLoggedIn) {
      if (boardType === 'aurora') {
        setPendingFormValues({ name: climbName, description, isDraft });
        openAuthModal({
          title: t('create.auth.signInTitle'),
          description: t('create.auth.signInDescription'),
          onSuccess: handleAuthSuccess,
        });
      }
      return;
    }

    if (boardType === 'aurora') {
      await doSaveAuroraClimb();
    } else {
      await doSaveMoonBoardClimb();
    }
  }, [
    boardType,
    isValid,
    climbName,
    isLoggedIn,
    description,
    isDraft,
    isCheckingMoonBoardDuplicate,
    moonBoardDuplicateError,
    doSaveAuroraClimb,
    doSaveMoonBoardClimb,
    openAuthModal,
    handleAuthSuccess,
    showMessage,
    t,
  ]);

  const canSave =
    isLoggedIn &&
    climbName.trim().length > 0 &&
    // MoonBoard: button is always clickable; handlePublish shows a snackbar when publishing an invalid climb,
    // and silently saves drafts regardless of validity.
    (boardType === 'moonboard' || isValid) &&
    (boardType !== 'moonboard' || (!isCheckingMoonBoardDuplicate && !moonBoardDuplicateError));

  const handleToggleSettings = useCallback(() => {
    setShowSettingsPanel((prev) => !prev);
  }, []);

  // Drafts: count query for the badge (Aurora only — MoonBoard has its own flow).
  // Scoped to the current layout/size/sets/angle so users see drafts for the wall in front of them.
  const canShowDrafts = boardType === 'aurora' && !!boardDetails && isLoggedIn;
  const draftsCountQueryKey = useMemo(() => {
    if (!boardDetails) return ['climbDraftsCount', 'disabled'] as const;
    return [
      'climbDraftsCount',
      boardDetails.board_name,
      boardDetails.layout_id,
      boardDetails.size_id,
      boardDetails.set_ids.join(','),
      angle,
    ] as const;
  }, [boardDetails, angle]);

  const { data: draftsCount } = useQuery({
    queryKey: draftsCountQueryKey,
    enabled: canShowDrafts && !!wsAuthToken,
    queryFn: async (): Promise<number> => {
      if (!boardDetails) return 0;
      const input: ClimbSearchInputVariables['input'] = {
        boardName: boardDetails.board_name,
        layoutId: boardDetails.layout_id,
        sizeId: boardDetails.size_id,
        setIds: boardDetails.set_ids.join(','),
        angle,
        page: 0,
        pageSize: 1,
        onlyDrafts: true,
      };
      const client = createGraphQLHttpClient(wsAuthToken);
      const result = await client.request<ClimbSearchCountResponse>(SEARCH_CLIMBS_COUNT, { input });
      return result.searchClimbs.totalCount ?? 0;
    },
    staleTime: 30 * 1000,
    refetchOnWindowFocus: false,
  });

  const handleOpenDrafts = useCallback(() => {
    setShowDraftsDrawer(true);
  }, []);

  const handleCloseDrafts = useCallback(() => {
    setShowDraftsDrawer(false);
  }, []);

  // Loads a draft climb back into the form so the user can keep working on it.
  // Aurora-only for now — the MoonBoard form doesn't mount a drafts drawer.
  //
  // Tracks the loaded row as savedClimb so subsequent Save presses update it
  // in place rather than creating a duplicate.
  //
  // The create form only ever produces single-frame climbs (framesCount: 1),
  // but a draft may originate from elsewhere with multiple frames. In that
  // case we flatten every frame into a single map — later frames override
  // earlier ones for the same hold id — so no holds are silently dropped.
  // Frame separation is lost on re-save, which is acceptable because the
  // editor has no concept of multiple frames.
  const handleLoadDraft = useCallback(
    (climb: Climb) => {
      if (boardType !== 'aurora' || !boardDetails || !loadAuroraHolds) return;

      const framesMap = convertLitUpHoldsStringToMap(climb.frames, boardDetails.board_name);
      const frameEntries = Object.entries(framesMap)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([, frame]) => frame);
      const mergedHolds = frameEntries.reduce((acc, frame) => ({ ...acc, ...frame }), {} as LitUpHoldsMap);
      loadAuroraHolds(mergedHolds);
      setClimbName(climb.name || '');
      setDescription(climb.description || '');
      setSavedClimb({
        uuid: climb.uuid,
        boardType: boardDetails.board_name,
        createdAt: climb.created_at ?? null,
        publishedAt: climb.published_at ?? null,
        isDraft: climb.is_draft ?? true,
      });
      clearJustSaved();
      // Push the loaded draft into the queue as the current climb so party peers
      // and any connected Bluetooth board see it. Start from a fresh queue slot
      // so subsequent saves replace the same item in place.
      setQueueItemUuid(null);
      if (queueActions) {
        void queueActions.setCurrentClimb(climb, { playlistSuggestionSource: null }).then((newItem) => {
          if (newItem) setQueueItemUuid(newItem.uuid);
        });
      }
      // The litUpHoldsMap effect at the top of this component pushes new frames
      // to a connected Bluetooth board automatically.
    },
    [boardType, boardDetails, loadAuroraHolds, clearJustSaved, queueActions],
  );

  const handleDraftDeleted = useCallback(
    (climb: Climb) => {
      void queryClient.invalidateQueries({ queryKey: draftsCountQueryKey });

      if (savedClimb?.uuid === climb.uuid && savedClimb.boardType === boardDetails?.board_name) {
        setSavedClimb(null);
        clearJustSaved();
      }
    },
    [boardDetails?.board_name, clearJustSaved, draftsCountQueryKey, queryClient, savedClimb],
  );

  // When the parent passes an editClimb (typically from
  // /b/.../create?editClimbUuid=...), seed the form once it has mounted.
  // Tracked by uuid so we only seed once per distinct target climb — subsequent
  // saves update savedClimb in place and must not trigger another reload.
  const seededEditClimbUuidRef = useRef<string | null>(null);
  useEffect(() => {
    if (!editClimb || boardType !== 'aurora' || !boardDetails || !loadAuroraHolds) return;
    if (seededEditClimbUuidRef.current === editClimb.uuid) return;
    seededEditClimbUuidRef.current = editClimb.uuid;
    handleLoadDraft(editClimb);
  }, [editClimb, boardType, boardDetails, loadAuroraHolds, handleLoadDraft]);

  // Surface a lookup failure from the create page (expired link, wrong
  // board, deleted row) exactly once per error value so the user knows why
  // the form came up empty.
  const shownEditClimbErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (!editClimbError) return;
    if (shownEditClimbErrorRef.current === editClimbError) return;
    shownEditClimbErrorRef.current = editClimbError;
    showMessage(editClimbError, 'error');
  }, [editClimbError, showMessage]);

  const handleToggleHeatmap = useCallback(() => {
    if (boardType !== 'aurora' || !boardDetails) return;
    setShowHeatmap((prev) => {
      track(`Create Climb Heatmap ${!prev ? 'Shown' : 'Hidden'}`, {
        boardLayout: boardDetails.layout_name || '',
      });
      return !prev;
    });
  }, [boardType, boardDetails]);

  // Rightmost save icon button. Collapses every state (saving, just-saved,
  // edit-locked, not-authenticated, idle) into a single icon button so the
  // bottom action row stays compact.
  const saveIconButton = useMemo(() => {
    if (boardType === 'aurora' && !isAuthenticated) {
      return (
        <MuiTooltip title={t('create.auth.signInTitle')}>
          <IconButton
            size="small"
            color="primary"
            onClick={() =>
              openAuthModal({
                title: t('create.auth.signInTitle'),
                description: t('create.auth.signInDescription'),
                onSuccess: handleAuthSuccess,
              })
            }
            aria-label={t('create.auth.signInAria')}
          >
            <LoginOutlined fontSize="small" />
          </IconButton>
        </MuiTooltip>
      );
    }

    if (boardType === 'moonboard' && !hasMoonBoardSessionUser) {
      return (
        <MuiTooltip title={t('create.auth.logInTitle')}>
          <IconButton
            size="small"
            color="primary"
            component={LocaleLink}
            href="/api/auth/signin"
            aria-label={t('create.auth.logInAria')}
          >
            <LoginOutlined fontSize="small" />
          </IconButton>
        </MuiTooltip>
      );
    }

    if (editLocked) {
      return (
        <MuiTooltip title={t('create.auth.editLockedTitle')}>
          <span>
            <IconButton size="small" disabled aria-label={t('create.auth.editLockedAria')}>
              <LockOutlined fontSize="small" />
            </IconButton>
          </span>
        </MuiTooltip>
      );
    }

    if (justSaved) {
      // Pure confirmation state — no onClick so a mis-tap can't fire off
      // another save. Flips back automatically on the next edit or after
      // the 3s timeout.
      return (
        <MuiTooltip title={t('create.auth.savedTitle')}>
          <IconButton size="small" color="success" disableRipple aria-label={t('create.auth.savedAria')}>
            <CheckCircleOutlined fontSize="small" />
          </IconButton>
        </MuiTooltip>
      );
    }

    const needsTitle = climbName.trim().length === 0;

    const handleSaveClick = () => {
      if (needsTitle) {
        setShowSettingsPanel(true);
        return;
      }
      void handlePublish();
    };

    let saveTooltip: string;
    if (isSaving) {
      saveTooltip = 'Saving...';
    } else if (needsTitle) {
      saveTooltip = 'Name your climb';
    } else {
      saveTooltip = 'Save climb';
    }

    return (
      <MuiTooltip title={saveTooltip}>
        <span>
          <IconButton
            size="small"
            color="primary"
            disabled={isSaving || (canSave === false && !needsTitle)}
            onClick={handleSaveClick}
            aria-label={isSaving ? 'Saving' : 'Save climb'}
          >
            {isSaving ? <CircularProgress size={16} /> : <SaveOutlined fontSize="small" />}
          </IconButton>
        </span>
      </MuiTooltip>
    );
  }, [
    boardType,
    isAuthenticated,
    hasMoonBoardSessionUser,
    editLocked,
    justSaved,
    isSaving,
    canSave,
    climbName,
    handlePublish,
    openAuthModal,
    handleAuthSuccess,
    t,
  ]);

  const titleClimb: ClimbTitleData = useMemo(
    () => ({
      name: climbName || 'Untitled climb',
      setter_username: session?.user?.name ?? undefined,
    }),
    [climbName, session?.user?.name],
  );

  let boardRenderer: React.ReactNode = null;
  if (boardType === 'aurora' && boardDetails) {
    boardRenderer = (
      <div className={styles.zoomFill}>
        <BoardRenderer
          boardDetails={boardDetails}
          litUpHoldsMap={litUpHoldsMap}
          mirrored={false}
          onHoldClick={picker.handleHoldClick}
          fillHeight
        />
        <CreateClimbHeatmapOverlay
          boardDetails={boardDetails}
          angle={angle}
          litUpHoldsMap={litUpHoldsMap}
          opacity={heatmapOpacity}
          enabled={showHeatmap}
          onLoadingChange={handleHeatmapLoadingChange}
        />
      </div>
    );
  } else if (boardType === 'moonboard' && layoutFolder && holdSetImages) {
    boardRenderer = (
      <div className={styles.moonboardFill}>
        <MoonBoardRenderer
          layoutFolder={layoutFolder}
          holdSetImages={holdSetImages}
          litUpHoldsMap={litUpHoldsMap}
          onHoldClick={picker.handleHoldClick}
          fillHeight
        />
      </div>
    );
  }

  return (
    <div className={styles.pageContainer} data-testid="climb-setter">
      {/* Header section: alerts + control row */}
      <div className={styles.headerSection}>
        {/* MoonBoard OCR errors */}
        {boardType === 'moonboard' && ocrError && (
          <MuiAlert severity="error" onClose={() => setOcrError(null)} className={styles.alertBanner}>
            {t('createClimbForm.alerts.importFailed', { error: ocrError })}
          </MuiAlert>
        )}

        {boardType === 'moonboard' && ocrWarnings.length > 0 && (
          <MuiAlert severity="warning" onClose={() => setOcrWarnings([])} className={styles.alertBanner}>
            {t('createClimbForm.alerts.importWarnings')}{' '}
            {ocrWarnings.map((w, i) => (
              <div key={i}>{w}</div>
            ))}
          </MuiAlert>
        )}

        {/* MoonBoard pre-save live check Alert. Two things govern when it
            shows: (1) the live debounced query has flagged a match, AND
            (2) the save-time CLIMB_IS_DUPLICATE gate hasn't already
            surfaced its own (richer) Alert. The two error UIs would
            otherwise stack on the same publish attempt. */}
        {boardType === 'moonboard' && moonBoardDuplicateError && !publishDuplicateError && (
          <MuiAlert severity="error" className={styles.alertBanner}>
            {moonBoardDuplicateError}
          </MuiAlert>
        )}

        {boardType === 'moonboard' &&
          !moonBoardDuplicateError &&
          !publishDuplicateError &&
          isCheckingMoonBoardDuplicate &&
          isValid && (
            <MuiAlert severity="info" className={styles.alertBanner}>
              {t('createClimbForm.alerts.checkingMoonBoardDuplicate')}
            </MuiAlert>
          )}

        {publishDuplicateError && (
          <MuiAlert
            severity="error"
            className={styles.alertBanner}
            action={
              publishDuplicateError.target ? (
                <MuiButton color="inherit" size="small" onClick={() => setShowDuplicateMatchDrawer(true)}>
                  {t('createClimbForm.alerts.viewMatchingClimb')}
                </MuiButton>
              ) : undefined
            }
          >
            {publishDuplicateError.existingClimbName
              ? t('createClimbForm.alerts.publishDuplicateNamed', {
                  name: publishDuplicateError.existingClimbName,
                })
              : t('createClimbForm.alerts.publishDuplicateUnnamed')}
          </MuiAlert>
        )}

        {/* Title row — mirrors play view: name + byline, settings icon on right.
            Draft label floats top-right so the transparent header avatar on the
            left doesn't collide with it. */}
        <div className={styles.climbTitleRow}>
          <div className={styles.climbTitleMain}>
            <ClimbTitle
              climb={titleClimb}
              layout="horizontal"
              showSetterInfo
              centered
              titleFontSize={themeTokens.typography.fontSize['2xl']}
            />
            {description && (
              <Typography variant="body2" color="text.secondary" className={styles.climbTitleDescription}>
                {description}
              </Typography>
            )}
          </div>
          {isDraft && (
            <div className={styles.climbTitleTrailing}>
              <Typography
                variant="body2"
                component="span"
                color="text.secondary"
                className={styles.climbTitleDraftBadge}
              >
                {t('createClimbForm.draftBadge')}
              </Typography>
            </div>
          )}
        </div>
      </div>

      {/* Board section: zoomable SVG renderer */}
      <div className={styles.boardSectionWrapper} data-testid="climb-setter-board">
        <ZoomableBoard resetKey={zoomResetKey}>{boardRenderer}</ZoomableBoard>
      </div>

      <HoldTypePicker
        boardName={pickerBoardName}
        anchorEl={picker.anchorEl}
        currentState={picker.currentState}
        startingCount={startingCount}
        finishCount={finishCount}
        onSelect={picker.handleSelect}
        onClose={picker.handleClose}
      />

      {/* MoonBoard-only: hidden file input (trigger lives in the bottom row) */}
      {boardType === 'moonboard' && (
        <input
          type="file"
          ref={fileInputRef}
          accept="image/png,image/jpeg,image/webp"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleOcrImport(file);
            e.target.value = '';
          }}
          disabled={isOcrProcessing}
        />
      )}

      {/* Bottom icon row — all actions, Save pinned right */}
      <div className={styles.bottomControls}>
        {boardType === 'aurora' && (
          <MuiTooltip title={showHeatmap ? 'Hide heatmap' : 'Show which holds get used most'}>
            <IconButton
              color={showHeatmap ? 'error' : 'default'}
              size="small"
              onClick={handleToggleHeatmap}
              className={styles.heatmapButton}
              aria-label={showHeatmap ? 'Hide heatmap' : 'Show heatmap'}
            >
              {showHeatmap && isHeatmapLoading ? (
                <CircularProgress size={16} />
              ) : (
                <LocalFireDepartmentOutlined fontSize="small" />
              )}
            </IconButton>
          </MuiTooltip>
        )}
        <ConfirmPopover
          title={t('create.clear.title')}
          description={t('create.clear.description')}
          onConfirm={resetHolds}
          okText={tCommon('actions.clear')}
          cancelText={tCommon('actions.cancel')}
        >
          <MuiTooltip title={t('create.clear.tooltip')}>
            <span>
              <IconButton size="small" disabled={totalHolds === 0} aria-label={t('create.clear.tooltip')}>
                <DeleteOutlined fontSize="small" />
              </IconButton>
            </span>
          </MuiTooltip>
        </ConfirmPopover>
        {canShowDrafts && (
          <MuiTooltip title={t('draftsDrawer.title')}>
            <Badge
              color="primary"
              badgeContent={draftsCount ?? 0}
              max={99}
              invisible={!draftsCount}
              overlap="rectangular"
            >
              <IconButton size="small" onClick={handleOpenDrafts} aria-label={t('createClimbForm.openDrafts')}>
                <DraftsOutlined fontSize="small" />
              </IconButton>
            </Badge>
          </MuiTooltip>
        )}
        {boardType === 'moonboard' && (
          <>
            <MuiTooltip
              title={isOcrProcessing ? t('createClimbForm.processing') : t('createClimbForm.importFromScreenshot')}
            >
              <span>
                <IconButton
                  size="small"
                  disabled={isOcrProcessing}
                  onClick={() => fileInputRef.current?.click()}
                  aria-label={t('createClimbForm.importFromScreenshot')}
                >
                  {isOcrProcessing ? <CircularProgress size={16} /> : <CloudUploadOutlined fontSize="small" />}
                </IconButton>
              </span>
            </MuiTooltip>
            <MuiTooltip title={t('createClimbForm.bulkImport')}>
              <IconButton
                size="small"
                component={LocaleLink}
                href={bulkImportUrl}
                aria-label={t('createClimbForm.bulkImport')}
              >
                <GetAppOutlined fontSize="small" />
              </IconButton>
            </MuiTooltip>
          </>
        )}
        {boardType === 'moonboard' && userGradeLabel && (
          <Typography
            variant="body2"
            component="span"
            className={styles.gradeBadge}
            sx={{ color: getSoftGradeColor(userGradeLabel, isDark) ?? 'var(--neutral-500)' }}
          >
            {userGradeLabel}
          </Typography>
        )}
        <div className={styles.bottomControlsSaveSlot}>
          {queueActions && (
            <MuiTooltip title={isPreviewActive ? 'Active' : 'Set active'}>
              <span>
                <IconButton
                  size="small"
                  disabled={totalHolds === 0 || isPreviewActive}
                  onClick={handleSetActive}
                  aria-label={isPreviewActive ? 'Currently active' : 'Set as active climb'}
                >
                  <PlayCircleOutlineOutlined
                    fontSize="small"
                    sx={isPreviewActive ? { color: themeTokens.colors.primary } : undefined}
                  />
                </IconButton>
              </span>
            </MuiTooltip>
          )}
          <MuiTooltip title={t('createClimbForm.settings.tooltip')}>
            <IconButton size="small" onClick={handleToggleSettings} aria-label={t('createClimbForm.settings.tooltip')}>
              <SettingsOutlined fontSize="small" />
            </IconButton>
          </MuiTooltip>
          {saveIconButton}
        </div>
      </div>

      {/* Drafts drawer — only for Aurora boards where boardDetails is loaded */}
      {canShowDrafts && boardDetails && (
        <DraftsDrawer
          open={showDraftsDrawer}
          onClose={handleCloseDrafts}
          boardDetails={boardDetails}
          angle={angle}
          onLoadDraft={handleLoadDraft}
          onDraftDeleted={handleDraftDeleted}
        />
      )}

      {/* Drawer that surfaces the existing climb whose holds matched, so the
          user can decide whether to drop their candidate, save as draft, or
          shift a hold. SimilarClimbsList runs the same query as the playview
          drawer's similar-climbs section, just pinned at threshold 1.0. */}
      {publishDuplicateError?.target && duplicateMatchBoardName && duplicateMatchLayoutId != null && (
        <SwipeableDrawer
          title={t('createClimbForm.alerts.identicalClimbDrawerTitle')}
          placement="bottom"
          open={showDuplicateMatchDrawer}
          onClose={() => setShowDuplicateMatchDrawer(false)}
          swipeEnabled
        >
          <Box sx={{ p: 2 }}>
            {publishDuplicateError.target.kind === 'frames' ? (
              <SimilarClimbsList
                boardType={duplicateMatchBoardName}
                layoutId={duplicateMatchLayoutId}
                frames={publishDuplicateError.target.frames}
                threshold={1.0}
                limit={20}
                emptyMessage={t('similarClimbs.emptyIdentical')}
              />
            ) : (
              <SimilarClimbsList
                boardType={duplicateMatchBoardName}
                layoutId={duplicateMatchLayoutId}
                climbUuid={publishDuplicateError.target.climbUuid}
                threshold={1.0}
                limit={20}
                emptyMessage={t('similarClimbs.emptyIdentical')}
              />
            )}
          </Box>
        </SwipeableDrawer>
      )}

      {/* Settings nested drawer */}
      <SwipeableDrawer
        title={t('createClimbForm.settings.title')}
        placement="bottom"
        open={showSettingsPanel}
        onClose={() => setShowSettingsPanel(false)}
        swipeEnabled={false}
        styles={SETTINGS_DRAWER_STYLES}
      >
        <div className={styles.settingsDrawerContent}>
          {/* Name */}
          <div className={styles.settingsField}>
            <Typography variant="body2" component="span" color="text.secondary" className={styles.settingsLabel}>
              {t('createClimbForm.fields.name')}
            </Typography>
            <TextField
              value={climbName}
              onChange={(e) => setClimbName(e.target.value)}
              placeholder={t('createClimbForm.namePlaceholder')}
              inputProps={{ maxLength: 100 }}
              variant="outlined"
              size="small"
              fullWidth
            />
          </div>

          {/* Draft toggle */}
          <div className={styles.settingsField}>
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
              <MuiSwitch size="small" checked={isDraft} onChange={(_, checked) => setIsDraft(checked)} />
              <Typography variant="body2" component="span">
                {t('createClimbForm.draftBadge')}
              </Typography>
            </Box>
          </div>

          {/* Hold count indicators */}
          <div className={styles.settingsField}>
            <Typography variant="body2" component="span" color="text.secondary" className={styles.settingsLabel}>
              {t('createClimbForm.fields.holds')}
            </Typography>
            <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap">
              {boardType === 'aurora' ? (
                <>
                  <HoldIndicator
                    count={startingCount}
                    max={2}
                    color={themeTokens.colors.success}
                    label={t('createClimbForm.holds.starting')}
                  />
                  <HoldIndicator
                    count={finishCount}
                    max={2}
                    color={themeTokens.colors.pink}
                    label={t('createClimbForm.holds.finish')}
                  />
                  <HoldIndicator
                    count={totalHolds}
                    color={themeTokens.colors.primary}
                    label={t('createClimbForm.holds.total')}
                  />
                </>
              ) : (
                <>
                  <HoldIndicator
                    count={startingCount}
                    max={2}
                    color={themeTokens.colors.error}
                    label={t('createClimbForm.holds.start')}
                  />
                  <HoldIndicator
                    count={handCount}
                    color={themeTokens.colors.primary}
                    label={t('createClimbForm.holds.hand')}
                  />
                  <HoldIndicator
                    count={finishCount}
                    max={2}
                    color={themeTokens.colors.success}
                    label={t('createClimbForm.holds.finish')}
                  />
                  <HoldIndicator
                    count={totalHolds}
                    color={themeTokens.colors.secondary}
                    label={t('createClimbForm.holds.total')}
                  />
                </>
              )}
            </Stack>
          </div>

          {/* MoonBoard-specific: Angle, Grade and Benchmark */}
          {boardType === 'moonboard' && (
            <>
              <div className={styles.settingsField}>
                <Typography variant="body2" component="span" color="text.secondary" className={styles.settingsLabel}>
                  {t('createClimbForm.fields.angle')}
                </Typography>
                <MuiSelect
                  value={selectedAngle}
                  onChange={(e) => setSelectedAngle(e.target.value)}
                  className={styles.settingsGradeField}
                  size="small"
                >
                  {MOONBOARD_ANGLES.map((a) => (
                    <MenuItem key={a} value={a}>
                      {`${a}°`}
                    </MenuItem>
                  ))}
                </MuiSelect>
              </div>
              <div className={styles.settingsField}>
                <Typography variant="body2" component="span" color="text.secondary" className={styles.settingsLabel}>
                  {t('createClimbForm.fields.grade')}
                </Typography>
                <MuiSelect
                  displayEmpty
                  value={userGrade ?? ''}
                  onChange={(e) => setUserGrade(e.target.value === '' ? undefined : e.target.value)}
                  className={styles.settingsGradeField}
                  size="small"
                >
                  <MenuItem value="">
                    <em>{t('createClimbForm.fields.gradeNone')}</em>
                  </MenuItem>
                  {MOONBOARD_GRADES.map((g) => (
                    <MenuItem key={g.value} value={g.value}>
                      {g.label}
                    </MenuItem>
                  ))}
                </MuiSelect>
              </div>
              <div className={styles.settingsField}>
                <Typography variant="body2" component="span" color="text.secondary" className={styles.settingsLabel}>
                  {t('createClimbForm.fields.method')}
                </Typography>
                <MuiSelect
                  value={method}
                  onChange={(e) => setMethod(e.target.value as MoonBoardMethodToken | '')}
                  className={styles.settingsGradeField}
                  size="small"
                >
                  <MenuItem value="">{t('createClimbForm.methodOptions.feetFollowHands')}</MenuItem>
                  <MenuItem value={CLIMB_CHARACTERISTICS.METHOD_FOOTLESS}>
                    {t('createClimbForm.methodOptions.footless')}
                  </MenuItem>
                  <MenuItem value={CLIMB_CHARACTERISTICS.METHOD_FOOTLESS_KICKBOARD}>
                    {t('createClimbForm.methodOptions.footlessKickboard')}
                  </MenuItem>
                  <MenuItem value={CLIMB_CHARACTERISTICS.METHOD_NO_KICKBOARD}>
                    {t('createClimbForm.methodOptions.noKickboard')}
                  </MenuItem>
                </MuiSelect>
              </div>
              <div className={styles.settingsField}>
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                  <MuiSwitch size="small" checked={isBenchmark} onChange={(_, checked) => setIsBenchmark(checked)} />
                  <Typography variant="body2" component="span">
                    {t('createClimbForm.fields.benchmark')}
                  </Typography>
                </Box>
              </div>
            </>
          )}
          {/* Common: Description */}
          <div className={styles.settingsField}>
            <Typography variant="body2" component="span" color="text.secondary" className={styles.settingsLabel}>
              {t('createClimbForm.fields.description')}
            </Typography>
            <TextField
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('createClimbForm.descriptionPlaceholder')}
              multiline
              rows={3}
              inputProps={{ maxLength: 500 }}
              variant="outlined"
              size="small"
              fullWidth
            />
          </div>
        </div>
        <Box sx={{ display: 'flex', gap: 1.5, mt: 2 }}>
          <MuiButton
            variant="outlined"
            onClick={() => setShowSettingsPanel(false)}
            sx={{
              flex: 1,
              height: 48,
              borderRadius: `${themeTokens.borderRadius.md}px`,
              fontSize: 16,
              fontWeight: 600,
            }}
          >
            {t('createClimbForm.dismiss')}
          </MuiButton>
          <MuiButton
            variant="contained"
            disabled={isSaving || !canSave}
            onClick={() => {
              setShowSettingsPanel(false);
              void handlePublish();
            }}
            startIcon={isSaving ? <CircularProgress size={16} /> : <SaveOutlined />}
            sx={{
              flex: 1,
              height: 48,
              borderRadius: `${themeTokens.borderRadius.md}px`,
              fontSize: 16,
              fontWeight: 600,
            }}
          >
            {isSaving ? 'Saving...' : 'Save'}
          </MuiButton>
        </Box>
      </SwipeableDrawer>
    </div>
  );
}
