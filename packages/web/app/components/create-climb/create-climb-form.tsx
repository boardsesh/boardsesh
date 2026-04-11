'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import MuiAlert from '@mui/material/Alert';
import MuiTooltip from '@mui/material/Tooltip';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import MuiButton from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import CircularProgress from '@mui/material/CircularProgress';
import MuiSwitch from '@mui/material/Switch';
import MuiSlider from '@mui/material/Slider';
import MuiSelect from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import Badge from '@mui/material/Badge';
import { SettingsOutlined, LocalFireDepartmentOutlined, SaveOutlined, LoginOutlined, CloudUploadOutlined, GetAppOutlined, DraftsOutlined } from '@mui/icons-material';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { track } from '@vercel/analytics';
import { useSession } from 'next-auth/react';
import BoardRenderer from '../board-renderer/board-renderer';
import MoonBoardRenderer from '../moonboard-renderer/moonboard-renderer';
import ZoomableBoard from '../board-renderer/zoomable-board';
import SwipeableDrawer from '../swipeable-drawer/swipeable-drawer';
import { useBoardProvider } from '../board-provider/board-provider-context';
import { useCreateClimb } from './use-create-climb';
import { useMoonBoardCreateClimb } from './use-moonboard-create-climb';
import { useBoardBluetooth } from '../board-bluetooth-control/use-board-bluetooth';
import type { MoonBoardClimbDuplicateMatch } from '@boardsesh/shared-schema';
import { BoardDetails } from '@/app/lib/types';
import { constructClimbListWithSlugs } from '@/app/lib/url-utils';
import { convertLitUpHoldsStringToMap } from '../board-renderer/util';
import { MOONBOARD_GRADES, MOONBOARD_ANGLES } from '@/app/lib/moonboard-config';
import { getSoftFontGradeColor } from '@/app/lib/grade-colors';
import { useColorMode } from '@/app/hooks/use-color-mode';
import { parseScreenshot } from '@boardsesh/moonboard-ocr/browser';
import { convertOcrHoldsToMap } from '@/app/lib/moonboard-climbs-db';
import { createGraphQLClient, execute, type Client } from '../graphql-queue/graphql-client';
import { getBackendWsUrl } from '@/app/lib/backend-url';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { useAuthModal } from '@/app/components/providers/auth-modal-provider';
import { useSnackbar } from '../providers/snackbar-provider';
import { refreshClimbSearchAfterSave } from '@/app/lib/climb-search-cache';
import CreateClimbHeatmapOverlay from './create-climb-heatmap-overlay';
import HoldStatusChip from './hold-status-chip';
import DraftsDrawer from './drafts-drawer';
import { useCreateHeaderBridgeSetters } from './create-header-bridge-context';
import {
  SEARCH_CLIMBS_COUNT,
  type ClimbSearchCountResponse,
  type ClimbSearchInputVariables,
} from '@/app/lib/graphql/operations/climb-search';
import {
  convertLitUpHoldsMapToMoonBoardHolds,
  isMoonBoardDuplicateError,
} from '@/app/lib/moonboard-climb-helpers';
import styles from './create-climb-form.module.css';
import {
  CHECK_MOONBOARD_CLIMB_DUPLICATES_QUERY,
  type CheckMoonBoardClimbDuplicatesResponse,
  type CheckMoonBoardClimbDuplicatesVariables,
  SAVE_MOONBOARD_CLIMB_MUTATION,
  type SaveMoonBoardClimbMutationVariables,
  type SaveMoonBoardClimbMutationResponse,
} from '@/app/lib/graphql/operations/new-climb-feed';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';


const SETTINGS_DRAWER_STYLES = {
  wrapper: { height: 'auto', maxHeight: '70vh' },
  body: { padding: 0 },
};

interface CreateClimbFormValues {
  name: string;
  description: string;
  isDraft: boolean;
}

type BoardType = 'aurora' | 'moonboard';

interface CreateClimbFormProps {
  boardType: BoardType;
  angle: number;
  // Aurora-specific
  boardDetails?: BoardDetails;
  forkFrames?: string;
  forkName?: string;
  // MoonBoard-specific
  layoutFolder?: string;
  layoutId?: number;
  holdSetImages?: string[];
}

export default function CreateClimbForm({
  boardType,
  angle,
  boardDetails,
  forkFrames,
  forkName,
  layoutFolder,
  layoutId,
  holdSetImages,
}: CreateClimbFormProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { data: session } = useSession();
  const { register, update, deregister } = useCreateHeaderBridgeSetters();
  const { mode } = useColorMode();
  const isDark = mode === 'dark';
  const queryClient = useQueryClient();

  // Aurora-specific hooks
  const { isAuthenticated, saveClimb } = useBoardProvider();
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
    handleHoldClick: baseHandleHoldClick,
    startingCount,
    finishCount,
    totalHolds,
    isValid,
    resetHolds: baseResetHolds,
  } = boardType === 'aurora' ? auroraClimb : moonboardClimb;

  const handCount = boardType === 'moonboard' ? moonboardClimb.handCount : 0;
  const generateFramesString = boardType === 'aurora' ? auroraClimb.generateFramesString : undefined;
  const setLitUpHoldsMap = boardType === 'moonboard' ? moonboardClimb.setLitUpHoldsMap : undefined;

  // Bluetooth for Aurora boards
  const { isConnected, sendFramesToBoard } = useBoardBluetooth({
    boardDetails: boardType === 'aurora' ? boardDetails : undefined
  });

  // Refs
  const fileInputRef = useRef<HTMLInputElement>(null);
  const graphqlClientRef = useRef<Client | null>(null);

  // Form state
  const [isSaving, setIsSaving] = useState(false);
  const { openAuthModal } = useAuthModal();
  const [pendingFormValues, setPendingFormValues] = useState<CreateClimbFormValues | null>(null);

  // Aurora-specific state
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [heatmapOpacity, setHeatmapOpacity] = useState(0.7);
  const [isDraft, setIsDraft] = useState(true);

  // MoonBoard-specific state
  const [isOcrProcessing, setIsOcrProcessing] = useState(false);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [ocrWarnings, setOcrWarnings] = useState<string[]>([]);
  const [userGrade, setUserGrade] = useState<string | undefined>(undefined);
  const [isBenchmark, setIsBenchmark] = useState(false);
  const [selectedAngle, setSelectedAngle] = useState<number>(angle);
  const [moonBoardDuplicateMatch, setMoonBoardDuplicateMatch] = useState<MoonBoardClimbDuplicateMatch | null>(null);
  const [isCheckingMoonBoardDuplicate, setIsCheckingMoonBoardDuplicate] = useState(false);

  // Common state
  const [climbName, setClimbName] = useState(forkName ? `${forkName} fork` : '');
  const [description, setDescription] = useState('');
  const [showSettingsPanel, setShowSettingsPanel] = useState(false);
  const [showDraftsDrawer, setShowDraftsDrawer] = useState(false);
  const zoomResetKey = boardType === 'moonboard' ? `moonboard-${selectedAngle}` : `aurora-${angle}`;
  const climbNameRef = useRef(climbName);
  const setClimbNameRef = useRef(setClimbName);
  const headerActionRef = useRef<React.ReactNode | null>(null);
  const duplicateCheckRequestIdRef = useRef(0);

  // Construct the bulk import URL (MoonBoard only)
  const bulkImportUrl = pathname.replace(/\/create$/, '/import');

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

  // Send frames to board whenever litUpHoldsMap changes (Aurora only)
  useEffect(() => {
    if (boardType === 'aurora' && isConnected && generateFramesString) {
      const frames = generateFramesString();
      sendFramesToBoard(frames);
    }
  }, [boardType, litUpHoldsMap, isConnected, generateFramesString, sendFramesToBoard]);

  // Wrap handleHoldClick
  const handleHoldClick = useCallback(
    (holdId: number) => {
      baseHandleHoldClick(holdId);
    },
    [baseHandleHoldClick],
  );

  // Wrap resetHolds to also clear the board
  const resetHolds = useCallback(() => {
    baseResetHolds();
    if (boardType === 'aurora' && isConnected) {
      sendFramesToBoard('');
    }
  }, [boardType, baseResetHolds, isConnected, sendFramesToBoard]);

  // MoonBoard OCR import
  const handleOcrImport = useCallback(async (file: File) => {
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
  }, [boardType, angle, setLitUpHoldsMap]);

  const runMoonBoardDuplicateCheck = useCallback(async (holds: NonNullable<typeof moonBoardHolds>) => {
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
  }, [layoutId, selectedAngle]);

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

  // Save climb - Aurora
  const doSaveAuroraClimb = useCallback(async () => {
    if (!boardDetails || !generateFramesString) return;

    setIsSaving(true);

    try {
      const frames = generateFramesString();

      await saveClimb({
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
      } else {
        // Refresh drafts list/count so the new draft shows up immediately.
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['climbDrafts', boardDetails.board_name, boardDetails.layout_id] }),
          queryClient.invalidateQueries({ queryKey: ['climbDraftsCount', boardDetails.board_name, boardDetails.layout_id] }),
        ]);
      }

      track('Climb Created', {
        boardLayout: boardDetails.layout_name || '',
        isDraft: isDraft,
        holdCount: totalHolds,
      });

      const listUrl = constructClimbListWithSlugs(
        boardDetails.board_name,
        boardDetails.layout_name || '',
        boardDetails.size_name || '',
        boardDetails.size_description,
        boardDetails.set_names || [],
        angle,
      );
      router.push(listUrl);
    } catch (error) {
      console.error('Failed to save climb:', error);
      track('Climb Create Failed', {
        boardLayout: boardDetails.layout_name || '',
      });
    } finally {
      setIsSaving(false);
    }
  }, [boardDetails, generateFramesString, saveClimb, climbName, description, isDraft, angle, totalHolds, router, queryClient]);

  // Save climb - MoonBoard
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
          setter: undefined,
        },
      };

      await execute<SaveMoonBoardClimbMutationResponse, SaveMoonBoardClimbMutationVariables>(
        graphqlClientRef.current,
        { query: SAVE_MOONBOARD_CLIMB_MUTATION, variables },
      );

      if (!isDraft) {
        await refreshClimbSearchAfterSave(queryClient, 'moonboard', layoutId);
      }

      showMessage('Climb saved to database!', 'success');

      const listUrl = pathname.replace(/\/create$/, '/list');
      router.push(listUrl);
    } catch (error) {
      console.error('Failed to save climb:', error);
      if (error instanceof Error && isMoonBoardDuplicateError(error.message)) {
        await runMoonBoardDuplicateCheck(moonBoardHolds);
      }
      showMessage(error instanceof Error ? error.message : 'Failed to save climb. Please try again.', 'error');
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
    isDraft,
    selectedAngle,
    pathname,
    router,
    wsAuthToken,
    queryClient,
    showMessage,
    runMoonBoardDuplicateCheck,
  ]);

  const handleAuthSuccess = useCallback(async () => {
    if (pendingFormValues) {
      setTimeout(async () => {
        setPendingFormValues(null);
      }, 1000);
    }
  }, [pendingFormValues]);

  const handlePublish = useCallback(async () => {
    if (!isValid || !climbName.trim()) {
      return;
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
          title: 'Sign in to save your climb',
          description: 'Create an account or sign in to save your climb to the board.',
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
  ]);

  const canSave = isLoggedIn
    && isValid
    && climbName.trim().length > 0
    && (boardType !== 'moonboard' || (!isCheckingMoonBoardDuplicate && !moonBoardDuplicateError));

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

  const handleToggleHeatmap = useCallback(() => {
    if (boardType !== 'aurora' || !boardDetails) return;
    setShowHeatmap((prev) => {
      track(`Create Climb Heatmap ${!prev ? 'Shown' : 'Hidden'}`, {
        boardLayout: boardDetails.layout_name || '',
      });
      return !prev;
    });
  }, [boardType, boardDetails]);

  const headerAction = useMemo(() => {
    if (boardType === 'aurora') {
      if (!isAuthenticated) {
        return (
          <MuiButton
            size="small"
            variant="contained"
            startIcon={<LoginOutlined />}
            onClick={() => openAuthModal({ title: 'Sign in to save your climb', description: 'Create an account or sign in to save your climb to the board.', onSuccess: handleAuthSuccess })}
          >
            Sign In
          </MuiButton>
        );
      }
      return (
        <MuiButton
          size="small"
          variant="contained"
          startIcon={isSaving ? <CircularProgress size={16} /> : <SaveOutlined />}
          disabled={isSaving || !canSave}
          onClick={handlePublish}
        >
          {isSaving ? 'Saving...' : 'Save'}
        </MuiButton>
      );
    }

    // MoonBoard
    if (!hasMoonBoardSessionUser) {
      return (
        <Link href="/api/auth/signin">
          <MuiButton size="small" variant="contained" startIcon={<LoginOutlined />}>
            Log In
          </MuiButton>
        </Link>
      );
    }
    return (
      <MuiButton
        size="small"
        variant="contained"
        startIcon={isSaving ? <CircularProgress size={16} /> : <SaveOutlined />}
        disabled={isSaving || !canSave}
        onClick={handlePublish}
      >
        {isSaving ? 'Saving...' : 'Save'}
      </MuiButton>
    );
  }, [boardType, isAuthenticated, openAuthModal, handleAuthSuccess, isSaving, canSave, handlePublish, hasMoonBoardSessionUser]);

  climbNameRef.current = climbName;
  setClimbNameRef.current = setClimbName;
  headerActionRef.current = headerAction;

  useEffect(() => {
    register({
      climbName: climbNameRef.current,
      setClimbName: setClimbNameRef.current,
      actionSlot: headerActionRef.current,
    });

    return () => {
      deregister();
    };
  }, [register, deregister]);

  useEffect(() => {
    update({
      climbName,
      setClimbName,
      actionSlot: headerAction,
    });
  }, [climbName, headerAction, setClimbName, update]);

  return (
    <div className={styles.pageContainer} data-testid="climb-setter">
      {/* Header section: alerts + control row */}
      <div className={styles.headerSection}>
        {/* MoonBoard OCR errors */}
        {boardType === 'moonboard' && ocrError && (
          <MuiAlert
            severity="error"
            onClose={() => setOcrError(null)}
            className={styles.alertBanner}
          >
            Import Failed: {ocrError}
          </MuiAlert>
        )}

        {boardType === 'moonboard' && ocrWarnings.length > 0 && (
          <MuiAlert
            severity="warning"
            onClose={() => setOcrWarnings([])}
            className={styles.alertBanner}
          >
            Import Warnings: {ocrWarnings.map((w, i) => <div key={i}>{w}</div>)}
          </MuiAlert>
        )}

        {boardType === 'moonboard' && moonBoardDuplicateError && (
          <MuiAlert severity="error" className={styles.alertBanner}>
            {moonBoardDuplicateError}
          </MuiAlert>
        )}

        {boardType === 'moonboard' && !moonBoardDuplicateError && isCheckingMoonBoardDuplicate && isValid && (
          <MuiAlert severity="info" className={styles.alertBanner}>
            Checking whether this MoonBoard climb already exists...
          </MuiAlert>
        )}

        <div className={styles.headerRow}>
          <div className={styles.headerControls}>
            <Typography variant="body2" component="span" color="text.secondary" className={styles.draftLabel}>
              Draft
            </Typography>
            <MuiSwitch
              size="small"
              checked={isDraft}
              onChange={(_, checked) => setIsDraft(checked)}
            />
            {/* Aurora-only: Heatmap toggle */}
            {boardType === 'aurora' && (
              <>
                <MuiTooltip title={showHeatmap ? 'Hide heatmap' : 'Show hold popularity heatmap'}>
                  <IconButton
                    color={showHeatmap ? 'error' : 'default'}
                    size="small"
                    onClick={handleToggleHeatmap}
                    className={styles.heatmapButton}
                  >
                    <LocalFireDepartmentOutlined />
                  </IconButton>
                </MuiTooltip>
                {showHeatmap && (
                  <>
                    <Typography variant="body2" component="span" color="text.secondary" className={styles.draftLabel}>
                      Opacity
                    </Typography>
                    <MuiSlider
                      min={0.1}
                      max={1}
                      step={0.1}
                      value={heatmapOpacity}
                      onChange={(_, value) => setHeatmapOpacity(value as number)}
                      className={styles.opacitySlider}
                    />
                  </>
                )}
              </>
            )}
            {boardType === 'moonboard' && userGrade && (
              <Typography
                variant="body2"
                component="span"
                className={styles.gradeBadge}
                style={{
                  color: getSoftFontGradeColor(userGrade, isDark) ?? 'var(--neutral-500)',
                }}
              >
                {userGrade}
              </Typography>
            )}
          </div>

          <Stack direction="row" spacing={1} alignItems="center">
            {canShowDrafts && (
              <Badge
                color="primary"
                badgeContent={draftsCount ?? 0}
                max={99}
                invisible={!draftsCount}
                overlap="rectangular"
              >
                <MuiButton
                  size="small"
                  variant="outlined"
                  startIcon={<DraftsOutlined />}
                  onClick={handleOpenDrafts}
                >
                  Drafts
                </MuiButton>
              </Badge>
            )}
            <MuiButton
              size="small"
              variant="outlined"
              startIcon={<SettingsOutlined />}
              onClick={handleToggleSettings}
            >
              Settings
            </MuiButton>
          </Stack>
        </div>
      </div>

      {/* Holds row: hold counts + Clear button */}
      <div className={styles.holdsRow}>
        <Stack direction="row" className={styles.holdsRowChips}>
          {boardType === 'aurora' ? (
            <>
              <HoldStatusChip label={`Starting: ${startingCount}/2`} active={startingCount > 0} tone="success" />
              <HoldStatusChip label={`Finish: ${finishCount}/2`} active={finishCount > 0} tone="pink" />
              <HoldStatusChip label={`Total: ${totalHolds}`} active={totalHolds > 0} tone="primary" />
            </>
          ) : (
            <>
              <HoldStatusChip label={`Start: ${startingCount}/2`} active={startingCount > 0} tone="error" />
              <HoldStatusChip label={`Hand: ${handCount}`} active={handCount > 0} tone="primary" />
              <HoldStatusChip label={`Finish: ${finishCount}/2`} active={finishCount > 0} tone="success" />
              <HoldStatusChip label={`Total: ${totalHolds}`} active={totalHolds > 0} tone="secondary" />
            </>
          )}
        </Stack>
        <MuiButton size="small" variant="outlined" onClick={resetHolds} disabled={totalHolds === 0}>
          Clear
        </MuiButton>
      </div>

      {/* Board section: zoomable SVG renderer */}
      <div className={styles.boardSectionWrapper} data-testid="climb-setter-board">
        <ZoomableBoard resetKey={zoomResetKey}>
          {boardType === 'aurora' && boardDetails ? (
            <div className={styles.zoomFill}>
              <BoardRenderer
                boardDetails={boardDetails}
                litUpHoldsMap={litUpHoldsMap}
                mirrored={false}
                onHoldClick={handleHoldClick}
                fillHeight
              />
              <CreateClimbHeatmapOverlay
                boardDetails={boardDetails}
                angle={angle}
                litUpHoldsMap={litUpHoldsMap}
                opacity={heatmapOpacity}
                enabled={showHeatmap}
              />
            </div>
          ) : boardType === 'moonboard' && layoutFolder && holdSetImages ? (
            <div className={styles.moonboardFill}>
              <MoonBoardRenderer
                layoutFolder={layoutFolder}
                holdSetImages={holdSetImages}
                litUpHoldsMap={litUpHoldsMap}
                onHoldClick={handleHoldClick}
              />
            </div>
          ) : null}
        </ZoomableBoard>
      </div>

      {/* MoonBoard validation hint band */}
      {boardType === 'moonboard' && !isValid && totalHolds > 0 && (
        <div className={styles.validationHintBar}>
          <Typography variant="body2" component="span" color="text.secondary">
            A valid climb needs at least 1 start hold and 1 finish hold
          </Typography>
        </div>
      )}

      {/* MoonBoard-only: Import buttons */}
      {boardType === 'moonboard' && (
        <div className={styles.importActionsBar}>
          <input
            type="file"
            ref={fileInputRef}
            accept="image/png,image/jpeg,image/webp"
            className={styles.hiddenFileInput}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleOcrImport(file);
              e.target.value = '';
            }}
            disabled={isOcrProcessing}
          />
          <MuiButton size="small" variant="outlined" startIcon={isOcrProcessing ? <CircularProgress size={16} /> : <CloudUploadOutlined />} disabled={isOcrProcessing} onClick={() => fileInputRef.current?.click()}>
            {isOcrProcessing ? 'Processing...' : 'Import'}
          </MuiButton>
          <Link href={bulkImportUrl}>
            <MuiButton size="small" variant="outlined" startIcon={<GetAppOutlined />}>Bulk</MuiButton>
          </Link>
        </div>
      )}

      {/* Drafts drawer — only for Aurora boards where boardDetails is loaded */}
      {canShowDrafts && boardDetails && (
        <DraftsDrawer
          open={showDraftsDrawer}
          onClose={handleCloseDrafts}
          boardDetails={boardDetails}
          angle={angle}
        />
      )}

      {/* Settings nested drawer — lazy-mounted */}
      {showSettingsPanel && (
        <SwipeableDrawer
          title="Climb Settings"
          placement="bottom"
          open={showSettingsPanel}
          onClose={() => setShowSettingsPanel(false)}
          swipeEnabled={false}
          styles={SETTINGS_DRAWER_STYLES}
        >
          <div className={styles.settingsDrawerContent}>
            {/* MoonBoard-specific: Angle, Grade and Benchmark */}
            {boardType === 'moonboard' && (
              <>
                <div className={styles.settingsField}>
                  <Typography variant="body2" component="span" color="text.secondary" className={styles.settingsLabel}>
                    Angle
                  </Typography>
                  <MuiSelect
                    value={selectedAngle}
                    onChange={(e) => setSelectedAngle(e.target.value as number)}
                    className={styles.settingsGradeField}
                    size="small"
                  >
                    {MOONBOARD_ANGLES.map(a => (
                      <MenuItem key={a} value={a}>{a}&deg;</MenuItem>
                    ))}
                  </MuiSelect>
                </div>
                <div className={styles.settingsField}>
                  <Typography variant="body2" component="span" color="text.secondary" className={styles.settingsLabel}>
                    Grade
                  </Typography>
                  <MuiSelect
                    displayEmpty
                    value={userGrade ?? ''}
                    onChange={(e) => setUserGrade(e.target.value === '' ? undefined : (e.target.value as string))}
                    className={styles.settingsGradeField}
                    size="small"
                  >
                    <MenuItem value=""><em>None</em></MenuItem>
                    {MOONBOARD_GRADES.map(g => (
                      <MenuItem key={g.value} value={g.value}>{g.label}</MenuItem>
                    ))}
                  </MuiSelect>
                </div>
                <div className={styles.settingsField}>
                  <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                    <MuiSwitch
                      size="small"
                      checked={isBenchmark}
                      onChange={(_, checked) => setIsBenchmark(checked)}
                    />
                    <Typography variant="body2" component="span">Benchmark</Typography>
                  </Box>
                </div>
              </>
            )}
            {/* Common: Description */}
            <div className={styles.settingsField}>
              <Typography variant="body2" component="span" color="text.secondary" className={styles.settingsLabel}>
                Description (optional)
              </Typography>
              <TextField
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Add beta or notes about your climb..."
                multiline
                rows={3}
                inputProps={{ maxLength: 500 }}
                variant="outlined"
                size="small"
                fullWidth
              />
            </div>
          </div>
        </SwipeableDrawer>
      )}
    </div>
  );
}
