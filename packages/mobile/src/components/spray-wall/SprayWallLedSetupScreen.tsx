import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Keyboard, Platform, ScrollView, StyleSheet, View, type ScrollViewInstance } from 'react-native';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  DEFAULT_TNUT_CORNERS,
  generateTnutGrid,
  generateLedPositions,
  createLedStripes,
  MAX_LED_POSITIONS,
  MAX_LED_STRIPES,
  expandLedGrid,
  hasStaleLedGrid,
  bindLedPositionsToHoles,
  moveTnutLedLinks,
  pruneTnutLedLinks,
  migrateHoldLedLinksToTnuts,
  migrateTnutLayoutColumns,
  createWiring,
  ledPairs,
  rowMajorLedIndices,
  setWiringInitialSkip,
  MAX_WIRING_SKIP,
  MAX_WIRING_TOTAL_SKIPS,
  type CableDirection,
  type CableStartCorner,
  isValidTnutGrid,
  MAX_TNUT_HOLES,
  type Quad,
  type TnutLayout,
  type TnutPattern,
  type TnutPoint,
  type CanonicalSprayHold,
  type LedPosition,
  type SprayLedPlacement,
} from '@boardsesh/spray-wall-geometry';
import { useTheme } from '../../providers/theme-provider';
import { useHeaderActions } from '../../hooks/use-header-actions';
import { useTransparentHeaderInset } from '../../hooks/use-transparent-header-inset';
import { useWindowBottomInset } from '../../hooks/use-window-bottom-inset';
import { useKeyboardHeight } from '../../hooks/use-keyboard-height';
import { useAndroidKeyboardScroll } from '../../hooks/use-android-keyboard-scroll';
import { useAuth } from '../../providers/auth-provider';
import { useConfirm, type ConfirmOptions } from '../../providers/dialog-provider';
import { useViewerUserId } from '../../hooks/use-viewer-user-id';
import { fetchSprayWallRenderData, sprayWallPublishedRenderDataQueryKey } from '../../lib/spray/spray-wall-loader';
import { sprayWallViewerGeneration } from '../../lib/spray/spray-wall-registry';
import { ensureSprayPhotoCached } from '../../lib/spray/spray-photo-cache';
import {
  cachedPhotoUri,
  lookPreviewSourceFromRenderData,
  type SprayLookPreviewSource,
} from '../../lib/spray/spray-look-preview';
import { loadSprayWallTnutLayout, saveSprayWallTnutLayout } from '../../lib/spray/spray-wall-tnut-store';
import { subscribeSprayWallLedUploadOutcome } from '../../lib/spray/spray-wall-led-cache';
import { sprayLedPhotoKey } from '../../lib/spray/spray-led-photo-key';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { createTnutCalibrationSession, closeTnutCalibrationSession } from '../../lib/spray/tnut-calibration-session';
import { Button } from '../Button';
import { PressableSurface } from '../PressableSurface';
import { BuilderTextInput } from '../board-discovery/BoardMetaFields';
import { FlattenedSprayPhoto } from './FlattenedSprayPhoto';
import { SprayCornerMarker } from './SprayCornerMarker';
import { TnutPatternThumbnail } from './TnutPatternThumbnail';
import { LedPlacementThumbnail } from './LedPlacementThumbnail';
import { SprayPhotoStage } from './SprayPhotoStage';
import { SpraySetupOverlay } from './SpraySetupOverlay';
import { SprayLedMapEditor } from './SprayLedMapEditor';
import { SprayLedLightingStep } from './SprayLedLightingStep';
import { SprayHoldLedStep } from './SprayHoldLedStep';
import { SprayLedStripeEditor } from './SprayLedStripeEditor';
import { SprayPointToolbar, type SprayPointMode } from './SprayPointToolbar';
import { nearestPhotoPointIndex } from './tnut-corner-viewport';
import { CablePatternThumbnail } from './CablePatternThumbnail';
import { useSprayWizardLeaveGuard } from './use-spray-wizard-leave-guard';

type LoadedSetup = {
  source: SprayLookPreviewSource;
  photoUri: string;
  photoKey: string;
  saved: TnutLayout | null;
  holds: readonly CanonicalSprayHold[];
};
type Step =
  | 'pattern'
  | 'offset'
  | 'align'
  | 'holes'
  | 'led'
  | 'stripeConfig'
  | 'ledPositions'
  | 'holdLeds'
  | 'holdAboveLeds'
  | 'cablePattern'
  | 'cableStart'
  | 'initialSkip'
  | 'wiring'
  | 'skips'
  | 'lighting';

/** Leaving these keeps the work on disk. Choosing a placement is not work yet, and stays discardable. */
const LED_WORK_STEPS: ReadonlySet<Step> = new Set<Step>([
  'ledPositions',
  'holdLeds',
  'holdAboveLeds',
  'cablePattern',
  'cableStart',
  'initialSkip',
  'wiring',
  'skips',
  'lighting',
]);

function sameLedPositions(left: readonly LedPosition[], right: readonly LedPosition[]): boolean {
  return (
    left.length === right.length &&
    left.every(({ id, x, y }, index) => id === right[index].id && x === right[index].x && y === right[index].y)
  );
}

/** Private photos use the same managed cache and perspective warp as Wall only. */
export function SprayWallLedSetupScreen({ wallUuid }: { wallUuid: string }) {
  const { isAuthenticated } = useAuth();
  const viewerId = useViewerUserId();
  const { t } = useTranslation('boards');
  if (!isAuthenticated || !viewerId) return <Text>{t('sprayLedSetup.loading')}</Text>;
  return <SetupLoader key={`${wallUuid}:${viewerId}`} wallUuid={wallUuid} />;
}

function SetupLoader({ wallUuid }: { wallUuid: string }) {
  const { t } = useTranslation('boards');
  const { systemColors, spacing } = useTheme();
  const headerInset = useTransparentHeaderInset();
  const queryClient = useQueryClient();
  const [loaded, setLoaded] = useState<LoadedSetup | null>(null);
  const [failure, setFailure] = useState<'load' | 'access' | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setFailure(null);
    void (async () => {
      try {
        if (attempt > 0)
          await queryClient.invalidateQueries({
            queryKey: sprayWallPublishedRenderDataQueryKey(wallUuid, sprayWallViewerGeneration()),
          });
        const [payload, saved] = await Promise.all([
          fetchSprayWallRenderData(queryClient, wallUuid),
          loadSprayWallTnutLayout(wallUuid, { forEditing: true }),
        ]);
        if (!active) return;
        // Any climber can light this wall; changing the setup follows Edit board.
        if (!payload?.wall.viewerCanEdit) {
          setFailure('access');
          return;
        }
        const source = lookPreviewSourceFromRenderData(payload, {
          layoutId: payload.wall.layoutId,
          versionId: payload.wall.currentVersion?.id,
        });
        if (!source) throw new Error('Missing wall frame');
        const photoUri = cachedPhotoUri(
          await ensureSprayPhotoCached(
            { layoutId: source.layoutId, versionId: source.versionId },
            { url: source.photoUrl, expiresAt: source.photoExpiresAt },
          ),
        );
        if (!photoUri) throw new Error('Missing wall photo');
        // Include the frame and calibration: no stale coordinates after a photo/reset/anchor change.
        const photoKey = sprayLedPhotoKey(source);
        if (active)
          setLoaded({
            source,
            photoUri,
            photoKey,
            saved,
            holds: payload.holds.map(({ id, cx, cy, r, outline }) => ({ id, cx, cy, r, outline })),
          });
      } catch {
        if (active) setFailure('load');
      }
    })();
    return () => {
      active = false;
    };
  }, [wallUuid, queryClient, attempt]);
  if (loaded) return <SetupWizard wallUuid={wallUuid} loaded={loaded} />;
  return (
    <View
      style={[
        styles.fill,
        {
          backgroundColor: systemColors.background,
          padding: spacing[4],
          paddingTop: headerInset + spacing[4],
          gap: spacing[3],
        },
      ]}
    >
      <Text>
        {failure === 'access'
          ? t('sprayLedSetup.unavailable')
          : failure
            ? t('sprayLedSetup.loadFailed')
            : t('sprayLedSetup.loading')}
      </Text>
      {failure === 'load' ? (
        <Button title={t('sprayLedSetup.retry')} onPress={() => setAttempt((previous) => previous + 1)} />
      ) : null}
    </View>
  );
}

function defaultLayout(photoKey: string): TnutLayout {
  return {
    version: 1,
    columnConvention: 'all',
    photoKey,
    pattern: 'grid',
    rows: 8,
    columns: 8,
    firstRowOffset: false,
    corners: DEFAULT_TNUT_CORNERS,
    holes: [],
  };
}

function gridSignature(layout: TnutLayout): string {
  return JSON.stringify([
    layout.pattern,
    layout.rows,
    layout.columns,
    layout.firstRowOffset,
    layout.corners,
    layout.columnConvention,
  ]);
}

function SetupWizard({ wallUuid, loaded }: { wallUuid: string; loaded: LoadedSetup }) {
  const { t } = useTranslation('boards');
  const { systemColors, brandColors, spacing } = useTheme();
  const router = useRouter();
  const confirm = useConfirm();
  const viewerId = useViewerUserId();
  const fullscreenSession = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (fullscreenSession.current) closeTnutCalibrationSession(fullscreenSession.current);
    },
    [],
  );
  const headerInset = useTransparentHeaderInset();
  const bottomInset = useWindowBottomInset();
  const keyboardHeight = useKeyboardHeight(Platform.OS === 'android');
  const headerHeight = useHeaderHeight();
  const scrollRef = useRef<ScrollViewInstance>(null);
  const keyboardScroll = useAndroidKeyboardScroll(scrollRef, keyboardHeight, headerHeight + spacing[4]);
  const matchingSaved = useMemo(
    () => (loaded.saved?.photoKey === loaded.photoKey ? migrateTnutLayoutColumns(loaded.saved) : null),
    [loaded.saved, loaded.photoKey],
  );
  const [photoChanged, setPhotoChanged] = useState(Boolean(loaded.saved && !matchingSaved));
  const [layout, setLayout] = useState<TnutLayout>(() => {
    const initial = matchingSaved ?? defaultLayout(loaded.photoKey);
    return initial.ledPositions
      ? { ...initial, ledPositions: bindLedPositionsToHoles(initial, loaded.source.frame) }
      : initial;
  });
  const [step, setStep] = useState<Step>('pattern');
  const hasUpperLayer = layout.ledPlacement === 'below' || layout.ledPlacement === 'alternating';
  const [ledCardContentHeights, setLedCardContentHeights] = useState<Partial<Record<SprayLedPlacement, number>>>({});
  const ledPlacements: SprayLedPlacement[] =
    layout.pattern === 'custom'
      ? ['center', 'sides', 'below']
      : layout.pattern === 'offset'
        ? ['center', 'sides', 'below', 'stripe', 'alternating']
        : ['center', 'sides', 'below', 'stripe'];
  const supportedLedPlacement = layout.ledPlacement !== undefined && ledPlacements.includes(layout.ledPlacement);
  const ledCardContentHeight = Math.max(0, ...ledPlacements.map((placement) => ledCardContentHeights[placement] ?? 0));
  useEffect(() => {
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [step]);
  const [rowsText, setRowsText] = useState(String(layout.rows));
  const [columnsText, setColumnsText] = useState(String(layout.columns));
  // Identity, not contents: an unchanged layout object is already on disk.
  const persisted = useRef<TnutLayout | null>(layout);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [expansionTooLarge, setExpansionTooLarge] = useState(false);
  useEffect(
    () =>
      // The save lands on the phone first, so this is the only place a failed upload shows up.
      subscribeSprayWallLedUploadOutcome((changedWallUuid, outcome) => {
        if (changedWallUuid === wallUuid) setSaveFailed(outcome === 'failed');
      }),
    [wallUuid],
  );
  const [dragging, setDragging] = useState(false);
  const [mode, setMode] = useState<SprayPointMode | null>(null);
  useEffect(() => {
    if (step === 'holes') setMode(null);
  }, [step]);
  const [history, setHistory] = useState<
    { layout: TnutLayout; ledSignature: string | null; ledBasis: TnutLayout | null }[]
  >([]);
  const [viewportWidth, setViewportWidth] = useState(0);
  const busy = useRef(false);
  const finished = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [direction, setDirection] = useState<CableDirection>(layout.wiring?.direction ?? 'horizontal');
  const [startCorner, setStartCorner] = useState<CableStartCorner>(layout.wiring?.startCorner ?? 'tl');
  const [initialSkipText, setInitialSkipText] = useState(String(layout.wiring?.initialSkip ?? 0));
  const [stripeOrientation, setStripeOrientation] = useState<'vertical' | 'horizontal'>(
    layout.ledStripes?.orientation ?? 'vertical',
  );
  const [stripeCountText, setStripeCountText] = useState(String(layout.ledStripes?.stripes[0]?.ledIds.length ?? 20));
  const stripeConfigBasis = useRef(
    layout.ledStripes
      ? { orientation: layout.ledStripes.orientation, count: layout.ledStripes.stripes[0]?.ledIds.length ?? 20 }
      : null,
  );
  const stripeCount = Number(stripeCountText);
  const validStripeCount = /^\d+$/.test(stripeCountText) && stripeCount >= 1 && stripeCount <= MAX_LED_POSITIONS;
  const ledSignature = (draft: TnutLayout) =>
    JSON.stringify([
      draft.holes,
      draft.ledPlacement,
      draft.corners,
      draft.rows,
      draft.columns,
      draft.columnConvention,
      draft.firstRowOffset,
    ]);
  const [initialLedSignature] = useState(() =>
    layout.ledPositions && !hasStaleLedGrid(layout) ? ledSignature(layout) : null,
  );
  const generatedLeds = useRef(initialLedSignature);
  const ledBasis = useRef(layout.ledPositions ? layout : null);
  const wiringSignature = (draft: TnutLayout, axis: CableDirection, corner: CableStartCorner) =>
    JSON.stringify([draft.ledPositions?.map(({ id }) => id), axis, corner]);
  const generatedWiring = useRef(
    layout.wiring ? wiringSignature(layout, layout.wiring.direction, layout.wiring.startCorner) : null,
  );
  const preserveWiring = Boolean(
    layout.wiring && generatedWiring.current === wiringSignature(layout, direction, startCorner),
  );
  const skipLimit = preserveWiring
    ? Math.min(
        MAX_WIRING_SKIP,
        MAX_WIRING_TOTAL_SKIPS - (layout.wiring?.skips.reduce((total, gap) => total + gap.count, 0) ?? 0),
      )
    : MAX_WIRING_SKIP;
  const initialSkip = Number(initialSkipText);
  const validInitialSkip = /^\d+$/.test(initialSkipText) && initialSkip <= skipLimit;
  const generatedSignature = useRef(matchingSaved ? gridSignature(matchingSaved) : null);
  const pendingPattern = useRef<{ layout: TnutLayout; gridSignature: string | null } | null>(null);
  const parsedRows = Number(rowsText);
  const parsedColumns = Number(columnsText);
  const maxColumns = layout.pattern === 'offset' ? 99 : 50;
  const validCount = (text: string, maximum = 50) => /^\d+$/.test(text) && Number(text) >= 1 && Number(text) <= maximum;
  const validCounts = validCount(rowsText) && validCount(columnsText, maxColumns);
  const validCorners = isValidTnutGrid({ ...layout, pattern: layout.pattern === 'offset' ? 'offset' : 'grid' });
  const { source, photoUri } = loaded;
  const photo = useMemo(
    () => ({ uri: photoUri, width: source.frame.width, height: source.frame.height }),
    [photoUri, source.frame.width, source.frame.height],
  );
  const quad: Quad = [
    layout.corners.topLeft,
    layout.corners.topRight,
    layout.corners.bottomRight,
    layout.corners.bottomLeft,
  ].map(({ x, y }) => [x * photo.width, y * photo.height]);

  function withUpdate(previous: TnutLayout, update: Partial<TnutLayout>): TnutLayout {
    const updated = { ...previous, ...update };
    const bound = update.ledPositions
      ? { ...updated, ledPositions: bindLedPositionsToHoles(updated, source.frame) }
      : updated;
    return update.holes ? pruneTnutLedLinks(bound) : bound;
  }

  function changeLayout(update: Partial<TnutLayout>) {
    if (busy.current) return;
    setLayout((previous) => withUpdate(previous, update));
    setSaveFailed(false);
    setExpansionTooLarge(false);
  }

  /** Next stays instant: the store queues each wall's writes, so the newest always lands last. */
  function saveWork(draft: TnutLayout) {
    pendingPattern.current = null;
    if (persisted.current === draft) return;
    persisted.current = draft;
    setSaveFailed(false);
    saveSprayWallTnutLayout(wallUuid, draft).catch(() => {
      if (persisted.current === draft) persisted.current = null;
      if (mounted.current) setSaveFailed(true);
    });
  }

  /** Untouched generated LEDs cost nothing to rebuild. Hand-placed ones and a cable path do. */
  function wouldDiscardHandWork() {
    if (layout.wiring?.paths.length) return true;
    // Rebuilding clears hand-made hold links too (the new LEDs reuse the old ids).
    if (layout.holdLeds?.length || layout.holdAboveLeds?.length || layout.tnutLeds?.length) return true;
    if (layout.ledGroups !== undefined) return true;
    if (layout.ledStripes?.stripes.length) return true;
    if (!layout.ledPositions) return false;
    const untouched = ledBasis.current ? generateLedPositions(ledBasis.current) : [];
    return !sameLedPositions(layout.ledPositions, untouched);
  }

  function changeCorners([topLeft, topRight, bottomRight, bottomLeft]: Quad) {
    changeLayout({
      corners: {
        topLeft: { x: topLeft[0] / photo.width, y: topLeft[1] / photo.height },
        topRight: { x: topRight[0] / photo.width, y: topRight[1] / photo.height },
        bottomLeft: { x: bottomLeft[0] / photo.width, y: bottomLeft[1] / photo.height },
        bottomRight: { x: bottomRight[0] / photo.width, y: bottomRight[1] / photo.height },
      },
    });
  }

  function openFullscreen() {
    if (!viewerId || dragging || busy.current || fullscreenSession.current) return;
    Keyboard.dismiss();
    const sessionId = createTnutCalibrationSession(
      {
        viewerId,
        source,
        photoUri,
        quad,
        grid: {
          pattern: layout.pattern === 'offset' ? 'offset' : 'grid',
          rows: layout.rows,
          columns: layout.columns,
          firstRowOffset: layout.firstRowOffset,
          columnConvention: layout.columnConvention,
        },
      },
      changeCorners,
      () => {
        fullscreenSession.current = null;
      },
    );
    fullscreenSession.current = sessionId;
    router.push({ pathname: '/spray-led-fullscreen', params: { sessionId } });
  }

  function previousStep() {
    if (busy.current) return;
    Keyboard.dismiss();
    if (LED_WORK_STEPS.has(step)) saveWork(layout);
    if (step === 'offset') setStep('pattern');
    else if (step === 'align') setStep(layout.pattern === 'offset' ? 'offset' : 'pattern');
    else if (step === 'holes') setStep(layout.pattern === 'custom' ? 'pattern' : 'align');
    else if (step === 'led') setStep('holes');
    else if (step === 'stripeConfig') setStep('led');
    else if (step === 'ledPositions') setStep(layout.ledPlacement === 'stripe' ? 'stripeConfig' : 'led');
    else if (step === 'holdLeds') setStep('ledPositions');
    else if (step === 'holdAboveLeds') setStep('holdLeds');
    else if (step === 'cablePattern') setStep(hasUpperLayer ? 'holdAboveLeds' : 'holdLeds');
    else if (step === 'cableStart') setStep('cablePattern');
    else if (step === 'initialSkip') setStep(direction === 'custom' ? 'cablePattern' : 'cableStart');
    else if (step === 'wiring') {
      // Light and tap (and Undo) can change the cable's starting index. Read
      // the current wiring before showing its field again, so Next preserves it.
      setInitialSkipText(String(layout.wiring?.initialSkip ?? 0));
      setStep('initialSkip');
    } else if (step === 'skips') setStep('wiring');
    else if (step === 'lighting') setStep('skips');
    else router.back();
  }

  async function confirmAction(options: ConfirmOptions, action: () => void) {
    busy.current = true;
    try {
      if ((await confirm(options)) && mounted.current) action();
    } finally {
      busy.current = false;
    }
  }

  useSprayWizardLeaveGuard((leave) => {
    if (finished.current) {
      leave();
      return;
    }
    if (busy.current) return;
    if (step !== 'pattern') {
      previousStep();
      return;
    }
    if (persisted.current === layout) {
      leave();
      return;
    }
    void confirmAction(
      {
        title: t('sprayLedSetup.discardTitle'),
        message: t('sprayLedSetup.discardBody'),
        cancelLabel: t('sprayLedSetup.keepEditing'),
        confirmLabel: t('sprayLedSetup.discard'),
        destructive: true,
      },
      leave,
    );
  });

  async function next() {
    if (busy.current) return;
    Keyboard.dismiss();
    if (step === 'pattern') {
      setStep(layout.pattern === 'offset' ? 'offset' : layout.pattern === 'grid' ? 'align' : 'holes');
      return;
    }
    if (step === 'offset') {
      setStep('align');
      return;
    }
    if (step === 'align') {
      if (!validCounts || !validCorners || layout.pattern === 'custom') return;
      const nextLayout = { ...layout, rows: parsedRows, columns: parsedColumns };
      const signature = gridSignature(nextLayout);
      if (generatedSignature.current !== signature) {
        pendingPattern.current = null;
        changeLayout({ ...nextLayout, holes: generateTnutGrid({ ...nextLayout, pattern: layout.pattern }) });
        generatedSignature.current = signature;
        setHistory([]);
      }
      setStep('holes');
      return;
    }
    if (step === 'led') {
      if (!supportedLedPlacement) return;
      if (layout.ledPlacement === 'stripe') {
        setStep('stripeConfig');
        return;
      }
      const signature = ledSignature(layout);
      if (generatedLeds.current === signature) {
        saveWork(layout);
        setStep('ledPositions');
        return;
      }
      const finishRebuild = (draft: TnutLayout) => {
        const bound = { ...draft, ledPositions: bindLedPositionsToHoles(draft, source.frame) };
        generatedLeds.current = signature;
        ledBasis.current = bound;
        generatedWiring.current = bound.wiring
          ? wiringSignature(bound, bound.wiring.direction, bound.wiring.startCorner)
          : null;
        setLayout(bound);
        saveWork(bound);
        setStep('ledPositions');
      };
      const expanded = ledBasis.current && expandLedGrid(ledBasis.current, layout);
      if (expanded === 'capacity') {
        setExpansionTooLarge(true);
        return;
      }
      if (expanded) {
        const applyExpansion = () => finishRebuild(expanded.layout);
        if (expanded.needsReview) {
          await confirmAction(
            {
              title: t('sprayLedSetup.expandLedsTitle'),
              message: t('sprayLedSetup.expandLedsBody'),
              cancelLabel: t('sprayLedSetup.keepEditing'),
              confirmLabel: t('sprayLedSetup.next'),
            },
            applyExpansion,
          );
        } else {
          applyExpansion();
        }
        return;
      }
      const rebuildLeds = () => {
        // Regenerated LEDs reuse ids, so hand-made hold links would point at the wrong ones.
        finishRebuild({
          ...layout,
          ledPositions: generateLedPositions(layout),
          wiring: undefined,
          holdLeds: [],
          holdAboveLeds: [],
          tnutLeds: [],
          ledGroups: undefined,
          ledStripes: undefined,
        });
      };
      if (wouldDiscardHandWork()) {
        await confirmAction(
          {
            title: t('sprayLedSetup.rebuildLedsTitle'),
            message: t('sprayLedSetup.rebuildLedsBody'),
            cancelLabel: t('sprayLedSetup.keepEditing'),
            confirmLabel: t('sprayLedSetup.rebuildLeds'),
            destructive: true,
          },
          rebuildLeds,
        );
      } else {
        rebuildLeds();
      }
      return;
    }
    if (step === 'stripeConfig') {
      if (!supportedLedPlacement || layout.ledPlacement !== 'stripe' || !validStripeCount) return;
      const basis = stripeConfigBasis.current;
      const unchanged = layout.ledStripes && basis?.orientation === stripeOrientation && basis.count === stripeCount;
      const draft = unchanged ? layout : createLedStripes(layout, stripeOrientation, stripeCount);
      if (draft === 'capacity') {
        setExpansionTooLarge(true);
        return;
      }
      const apply = () => {
        const bound = { ...draft, ledPositions: bindLedPositionsToHoles(draft, source.frame) };
        setLayout(bound);
        generatedLeds.current = ledSignature(bound);
        ledBasis.current = bound;
        generatedWiring.current = bound.wiring
          ? wiringSignature(bound, bound.wiring.direction, bound.wiring.startCorner)
          : null;
        stripeConfigBasis.current = { orientation: stripeOrientation, count: stripeCount };
        saveWork(bound);
        setStep('ledPositions');
      };
      if (!unchanged && ledBasis.current && (wouldDiscardHandWork() || layout.ledStripes)) {
        await confirmAction(
          {
            title: t('sprayLedSetup.rebuildLedsTitle'),
            message: t('sprayLedSetup.rebuildLedsBody'),
            cancelLabel: t('sprayLedSetup.keepEditing'),
            confirmLabel: t('sprayLedSetup.rebuildLeds'),
            destructive: true,
          },
          apply,
        );
      } else apply();
      return;
    }
    if (step === 'ledPositions') {
      if (!layout.ledPositions?.length) return;
      saveWork(layout);
      // Holds are linked to LED positions before the cable: the links depend on
      // where the LEDs are, not on how the strip runs.
      setStep('holdLeds');
      return;
    }
    if (step === 'holdLeds') {
      const confirmed = migrateHoldLedLinksToTnuts(layout, source.frame, loaded.holds);
      setLayout(confirmed);
      saveWork(confirmed);
      setStep(hasUpperLayer ? 'holdAboveLeds' : 'cablePattern');
      return;
    }
    if (step === 'holdAboveLeds') {
      const confirmed = migrateHoldLedLinksToTnuts(layout, source.frame, loaded.holds);
      setLayout(confirmed);
      saveWork(confirmed);
      setStep('cablePattern');
      return;
    }
    if (step === 'cablePattern' || step === 'cableStart') {
      saveWork(layout);
      setStep(step === 'cablePattern' && direction !== 'custom' ? 'cableStart' : 'initialSkip');
      return;
    }
    if (step === 'initialSkip') {
      if (!validInitialSkip) return;
      const signature = wiringSignature(layout, direction, startCorner);
      const wiring =
        preserveWiring && layout.wiring
          ? layout.wiring
          : createWiring(layout.ledPositions ?? [], direction, startCorner, layout, ledPairs(layout));
      const startingWiring = setWiringInitialSkip(wiring, initialSkip);
      const draft = startingWiring === layout.wiring ? layout : withUpdate(layout, { wiring: startingWiring });
      setLayout(draft);
      saveWork(draft);
      generatedWiring.current = signature;
      setStep('wiring');
      return;
    }
    if (step === 'wiring' || step === 'skips') {
      if (!layout.wiring || !layout.ledPositions?.length) return;
      saveWork(layout);
      setStep(step === 'wiring' ? 'skips' : 'lighting');
      return;
    }
    if (step === 'holes' || step === 'lighting') {
      if (!layout.holes.length) return;
      if (step === 'lighting' && (!layout.ledPositions?.length || !layout.wiring)) return;
      if (step === 'holes' && ledBasis.current && generatedLeds.current !== ledSignature(layout)) {
        // Keep the saved hole and LED geometry in agreement if the wizard is
        // closed here. The next step saves them together once reconciled.
        setStep('led');
        return;
      }
      busy.current = true;
      setSaving(true);
      setSaveFailed(false);
      try {
        await saveSprayWallTnutLayout(wallUuid, layout);
        persisted.current = layout;
        if (mounted.current) {
          setSaveFailed(false);
          setPhotoChanged(false);
          if (step === 'holes') setStep('led');
          else {
            finished.current = true;
            router.back();
          }
        }
      } catch {
        if (mounted.current) setSaveFailed(true);
      } finally {
        busy.current = false;
        if (mounted.current) setSaving(false);
      }
      return;
    }
  }

  const canContinue =
    !saving &&
    !dragging &&
    (step !== 'align' || (validCounts && validCorners)) &&
    (step !== 'holes' || layout.holes.length > 0) &&
    (step !== 'led' || supportedLedPlacement) &&
    (step !== 'stripeConfig' || (supportedLedPlacement && layout.ledPlacement === 'stripe' && validStripeCount)) &&
    (step !== 'initialSkip' || validInitialSkip) &&
    ((step !== 'ledPositions' && step !== 'wiring' && step !== 'skips') || Boolean(layout.ledPositions?.length));
  useHeaderActions({
    leading: { kind: 'back', onPress: previousStep, accessibilityLabel: t('sprayLedSetup.back'), disabled: saving },
    trailing: {
      label: step === 'lighting' ? t('sprayLedSetup.done') : t('sprayLedSetup.next'),
      onPress: () => void next(),
      disabled: !canContinue,
    },
    clearOnUnmount: true,
  });

  function updateHoles(holes: TnutPoint[], draft: TnutLayout = layout) {
    if (busy.current) return;
    pendingPattern.current = null;
    const snapshot = { layout, ledSignature: generatedLeds.current, ledBasis: ledBasis.current };
    setHistory((previous) => [...previous.slice(-29), snapshot]);
    changeLayout(pruneTnutLedLinks({ ...draft, holes }));
  }

  function tapHole(point: TnutPoint, width: number, height: number) {
    if (mode === 'remove') {
      const index = nearestPhotoPointIndex(layout.holes, point, width, height, 18);
      if (index >= 0) updateHoles(layout.holes.filter((_, entry) => entry !== index));
    } else if (
      mode === 'add' &&
      layout.holes.length < MAX_TNUT_HOLES &&
      nearestPhotoPointIndex(layout.holes, point, width, height, 8) < 0
    ) {
      updateHoles([...layout.holes, point]);
    }
  }

  function moveHole(start: TnutPoint, end: TnutPoint, width: number, height: number) {
    if (mode !== 'move') return;
    const index = nearestPhotoPointIndex(layout.holes, start, width, height, 22);
    const occupied = nearestPhotoPointIndex(layout.holes, end, width, height, 6);
    if (index >= 0 && (occupied < 0 || occupied === index)) {
      const holes = layout.holes.map((hole, entry) => (entry === index ? end : hole));
      const moved = pruneTnutLedLinks({ ...moveTnutLedLinks(layout, layout.holes[index], end), holes });
      updateHoles(holes, moved);
      // Moving one mounting marker does not rebuild physical LEDs or the cable.
      // Base grid/calibration changes still use the explicit rebuild path.
      if (moved.ledPositions && generatedLeds.current === ledSignature(layout)) {
        generatedLeds.current = ledSignature(moved);
        ledBasis.current = moved;
      }
    }
  }

  const holeTools = {
    mode,
    onModeChange: setMode,
    canUndo: history.length > 0 && !saving,
    onUndo: () => {
      const previous = history.at(-1);
      if (!previous || busy.current) return;
      changeLayout(previous.layout);
      generatedLeds.current = previous.ledSignature;
      ledBasis.current = previous.ledBasis;
      setHistory((entries) => entries.slice(0, -1));
    },
  };

  const renderBackdrop = useCallback(
    (width: number, height: number) => (
      <FlattenedSprayPhoto source={source} photoUri={photoUri} tile={{ width, height }} />
    ),
    [source, photoUri],
  );
  const title =
    step === 'pattern'
      ? t('sprayLedSetup.patternTitle')
      : step === 'offset'
        ? t('sprayLedSetup.offsetTitle')
        : step === 'align'
          ? t('sprayLedSetup.alignTitle')
          : step === 'holes'
            ? t('sprayLedSetup.editTitle')
            : step === 'led'
              ? t('sprayLedSetup.ledTitle')
              : step === 'stripeConfig'
                ? t('sprayLedSetup.stripeConfigTitle')
                : step === 'ledPositions'
                  ? layout.ledPlacement === 'stripe'
                    ? t('sprayLedSetup.stripeEditorTitle')
                    : t('sprayLedSetup.ledPositionsTitle')
                  : step === 'cablePattern'
                    ? t('sprayLedSetup.cablePatternTitle')
                    : step === 'cableStart'
                      ? t('sprayLedSetup.cableStartTitle')
                      : step === 'initialSkip'
                        ? t('sprayLedSetup.initialSkipTitle')
                        : step === 'lighting'
                          ? t('sprayLedSetup.lightingTitle')
                          : step === 'holdLeds'
                            ? hasUpperLayer
                              ? t('sprayLedSetup.holdLedsBelowTitle')
                              : t('sprayLedSetup.holdLedsTitle')
                            : step === 'holdAboveLeds'
                              ? t('sprayLedSetup.holdLedsAboveTitle')
                              : step === 'skips'
                                ? t('sprayLedSetup.skipsTitle')
                                : t('sprayLedSetup.wiringTitle');

  return (
    <ScrollView
      ref={scrollRef}
      onLayout={({ nativeEvent }) => setViewportWidth(nativeEvent.layout.width)}
      {...keyboardScroll}
      automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
      style={[styles.fill, { backgroundColor: systemColors.background }]}
      scrollEnabled={!dragging}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentContainerStyle={{
        paddingTop: headerInset + spacing[4],
        paddingBottom: bottomInset + keyboardHeight + spacing[6],
        paddingHorizontal: spacing[4],
      }}
    >
      <View style={[styles.content, { gap: spacing[4] }]}>
        <Text variant="title2">{title}</Text>
        {photoChanged ? <Text variant="footnote">{t('sprayLedSetup.photoChanged')}</Text> : null}
        {step === 'pattern' ? (
          <>
            <Text>{t('sprayLedSetup.patternHint')}</Text>
            <View style={[styles.row, { gap: spacing[2] }]}>
              {(['grid', 'offset', 'custom'] as const).map((pattern) => (
                <PatternCard
                  key={pattern}
                  pattern={pattern}
                  label={
                    pattern === 'grid'
                      ? t('sprayLedSetup.grid')
                      : pattern === 'offset'
                        ? t('sprayLedSetup.offset')
                        : t('sprayLedSetup.custom')
                  }
                  selected={layout.pattern === pattern}
                  onPress={() => {
                    if (pattern !== layout.pattern) {
                      const basis = pendingPattern.current ?? { layout, gridSignature: generatedSignature.current };
                      const restored = pattern === basis.layout.pattern ? basis : null;
                      pendingPattern.current = restored ? null : basis;
                      // Browsing a pattern is reversible until its holes or LEDs
                      // are committed. Restore manual holes and links together.
                      const draft = restored?.layout ?? {
                        ...layout,
                        pattern,
                        columns: Math.min(pattern === 'offset' ? 99 : 50, layout.columns),
                        holes: [],
                        ledPlacement:
                          layout.ledPlacement === 'alternating' ||
                          (pattern === 'custom' && layout.ledPlacement === 'stripe')
                            ? undefined
                            : layout.ledPlacement,
                      };
                      changeLayout(draft);
                      setRowsText(String(draft.rows));
                      setColumnsText(String(draft.columns));
                      setHistory([]);
                      generatedSignature.current = restored?.gridSignature ?? null;
                    }
                  }}
                />
              ))}
            </View>
            <Text variant="footnote" color={systemColors.secondaryLabel}>
              {t('sprayLedSetup.localHint')}
            </Text>
          </>
        ) : null}
        {step === 'offset' ? (
          <>
            <Text>{t('sprayLedSetup.offsetHint')}</Text>
            <View style={[styles.row, { gap: spacing[3] }]}>
              <PatternCard
                pattern="offset"
                selected={!layout.firstRowOffset}
                label={t('sprayLedSetup.firstFull')}
                onPress={() => changeLayout({ firstRowOffset: false })}
              />
              <PatternCard
                pattern="offset"
                firstRowOffset
                selected={layout.firstRowOffset}
                label={t('sprayLedSetup.firstInset')}
                onPress={() => changeLayout({ firstRowOffset: true })}
              />
            </View>
          </>
        ) : null}
        {step === 'align' ? (
          <>
            <Text>
              {layout.rows === 1 && layout.columns === 1
                ? t('sprayLedSetup.singlePointHint')
                : layout.rows === 1
                  ? layout.pattern === 'offset'
                    ? t('sprayLedSetup.singleOffsetRowHint')
                    : t('sprayLedSetup.singleRowHint')
                  : layout.columns === 1
                    ? t('sprayLedSetup.singleColumnHint')
                    : layout.pattern === 'offset'
                      ? t('sprayLedSetup.offsetAlignHint')
                      : t('sprayLedSetup.gridHint')}
            </Text>
            <View style={[styles.stage, { width: viewportWidth, alignSelf: 'center' }]}>
              <SprayCornerMarker
                photo={photo}
                value={quad}
                maxWidth={viewportWidth}
                maxHeight={(viewportWidth * photo.height) / photo.width}
                enableZoom
                edgeToEdge
                invalid={!validCorners}
                renderBackdrop={renderBackdrop}
                onDragActiveChange={setDragging}
                tnutGrid={{
                  pattern: layout.pattern === 'offset' ? 'offset' : 'grid',
                  rows: layout.rows,
                  columns: layout.columns,
                  firstRowOffset: layout.firstRowOffset,
                  columnConvention: layout.columnConvention,
                }}
                onChange={changeCorners}
              />
              <PressableSurface
                accessibilityRole="button"
                accessibilityLabel={t('sprayLedSetup.fullScreen')}
                disabled={dragging}
                onPress={openFullscreen}
                style={[styles.fullscreen, { backgroundColor: systemColors.secondaryGroupedBackground }]}
              >
                <Icon name="expand" size={22} color={systemColors.label} />
              </PressableSurface>
            </View>
            <Text variant="footnote" color={systemColors.secondaryLabel}>
              {t('sprayLedSetup.zoomHint')}
            </Text>
            {!validCorners ? <Text color={brandColors.error}>{t('sprayLedSetup.invalidCorners')}</Text> : null}
            <CountControl
              label={t('sprayLedSetup.rows')}
              value={rowsText}
              onChange={(text) => {
                setRowsText(text);
                if (validCount(text)) changeLayout({ rows: Number(text) });
              }}
            />
            <CountControl
              label={t('sprayLedSetup.columns')}
              maximum={maxColumns}
              value={columnsText}
              onChange={(text) => {
                setColumnsText(text);
                if (validCount(text, maxColumns)) changeLayout({ columns: Number(text) });
              }}
            />
            {!validCounts ? (
              <Text color={brandColors.error}>{t('sprayLedSetup.countRange', { max: maxColumns })}</Text>
            ) : null}
            {layout.pattern === 'offset' ? <Text variant="footnote">{t('sprayLedSetup.countHint')}</Text> : null}
            {layout.holes.length > 0 && gridSignature(layout) !== generatedSignature.current ? (
              <Text variant="footnote">{t('sprayLedSetup.regenerateHint')}</Text>
            ) : null}
            <Button
              title={t('sprayLedSetup.resetCorners')}
              variant="text"
              onPress={() => changeLayout({ corners: DEFAULT_TNUT_CORNERS })}
            />
          </>
        ) : null}
        {step === 'holes' ? (
          <>
            <Text>{layout.pattern === 'custom' ? t('sprayLedSetup.customHint') : t('sprayLedSetup.refineHint')}</Text>
            {layout.pattern !== 'custom' ? <Text variant="footnote">{t('sprayLedSetup.customHint')}</Text> : null}
            <SprayPointToolbar {...holeTools} />
            <SprayPhotoStage
              width={viewportWidth}
              tools={<SprayPointToolbar {...holeTools} />}
              fullScreenRail={<SprayPointToolbar {...holeTools} icons />}
              canvas={{
                source,
                photoUri,
                mode: mode === 'move' ? 'move' : mode ? 'tap' : 'pan',
                onTap: tapHole,
                ignoreTapsOutsidePhoto: mode === 'add',
                onMove: moveHole,
                dragPoints: layout.holes,
                draftColor: brandColors.warning,
                onInteractionChange: setDragging,
                renderOverlay: (width, height, zoom, panX, panY, liveDrag) => (
                  <SpraySetupOverlay
                    holes={layout.holes}
                    liveDrag={liveDrag}
                    liveDragTarget="holes"
                    width={width}
                    height={height}
                    zoom={zoom}
                    panX={panX}
                    panY={panY}
                  />
                ),
              }}
            />
            <Text accessibilityLiveRegion="polite">{t('sprayLedSetup.holes', { count: layout.holes.length })}</Text>
            {!layout.holes.length ? <Text variant="footnote">{t('sprayLedSetup.needHole')}</Text> : null}
            {layout.holes.length >= MAX_TNUT_HOLES ? (
              <Text variant="footnote">{t('sprayLedSetup.holeLimit')}</Text>
            ) : null}
          </>
        ) : null}
        {saving ? <Text accessibilityLiveRegion="polite">{t('sprayLedSetup.saving')}</Text> : null}
        {saveFailed ? (
          <Text accessibilityLiveRegion="polite" color={brandColors.error}>
            {t('sprayLedSetup.saveFailed')}
          </Text>
        ) : null}
        {step === 'led' ? (
          <>
            <Text>{t('sprayLedSetup.ledHint')}</Text>
            {expansionTooLarge ? <Text color={brandColors.error}>{t('sprayLedSetup.expandLedsCapacity')}</Text> : null}
            <View style={[styles.ledGrid, { margin: -spacing[1] }]}>
              {ledPlacements.map((placement) => (
                <View key={placement} style={[styles.ledCell, { padding: spacing[1] }]}>
                  <ChoiceCard
                    label={
                      placement === 'center'
                        ? t('sprayLedSetup.ledCenter')
                        : placement === 'sides'
                          ? t('sprayLedSetup.ledSides')
                          : placement === 'below'
                            ? t('sprayLedSetup.ledBelow')
                            : placement === 'stripe'
                              ? t('sprayLedSetup.ledStripe')
                              : t('sprayLedSetup.ledAlternating')
                    }
                    selected={layout.ledPlacement === placement}
                    disabled={saving}
                    onPress={() => changeLayout({ ledPlacement: placement })}
                    minimumHeight={ledCardContentHeight ? ledCardContentHeight + spacing[2] * 2 + 4 : undefined}
                    onMeasureContent={(height) =>
                      setLedCardContentHeights((previous) =>
                        previous[placement] === height ? previous : { ...previous, [placement]: height },
                      )
                    }
                  >
                    <LedPlacementThumbnail placement={placement} firstRowOffset={layout.firstRowOffset} />
                  </ChoiceCard>
                </View>
              ))}
            </View>
            {layout.pattern === 'offset' && layout.ledPlacement === 'alternating' ? (
              <Text variant="footnote">{t('sprayLedSetup.ledAlternatingHint')}</Text>
            ) : null}

            <Text variant="footnote" color={systemColors.secondaryLabel}>
              {t('sprayLedSetup.localHint')}
            </Text>
          </>
        ) : null}
        {step === 'stripeConfig' ? (
          <>
            <Text>{t('sprayLedSetup.stripeConfigHint')}</Text>
            <View style={[styles.row, { gap: spacing[2] }]}>
              <Button
                title={t('sprayLedSetup.vertical')}
                variant={stripeOrientation === 'vertical' ? 'filled' : 'outlined'}
                onPress={() => {
                  setStripeOrientation('vertical');
                  setExpansionTooLarge(false);
                }}
              />
              <Button
                title={t('sprayLedSetup.horizontal')}
                variant={stripeOrientation === 'horizontal' ? 'filled' : 'outlined'}
                onPress={() => {
                  setStripeOrientation('horizontal');
                  setExpansionTooLarge(false);
                }}
              />
            </View>
            <CountControl
              label={t('sprayLedSetup.stripeCount')}
              value={stripeCountText}
              maximum={MAX_LED_POSITIONS}
              onChange={(text) => {
                setStripeCountText(text);
                setExpansionTooLarge(false);
              }}
            />
            {!validStripeCount ? (
              <Text color={brandColors.error}>{t('sprayLedSetup.stripeCountRange', { max: MAX_LED_POSITIONS })}</Text>
            ) : null}
            {expansionTooLarge ? (
              <Text color={brandColors.error} accessibilityLiveRegion="polite">
                {t('sprayLedSetup.stripeCapacity', { max: MAX_LED_POSITIONS, stripes: MAX_LED_STRIPES })}
              </Text>
            ) : null}
          </>
        ) : null}
        {step === 'ledPositions' && layout.ledPlacement === 'stripe' ? (
          <SprayLedStripeEditor
            layout={layout}
            defaultCount={validStripeCount ? stripeCount : 20}
            source={source}
            photoUri={photoUri}
            width={viewportWidth}
            onChange={changeLayout}
            onInteractionChange={setDragging}
          />
        ) : null}
        {(step === 'ledPositions' && layout.ledPlacement !== 'stripe') || step === 'wiring' || step === 'skips' ? (
          <SprayLedMapEditor
            key={step}
            kind={step === 'ledPositions' ? 'positions' : step}
            layout={layout}
            wallUuid={wallUuid}
            onChange={changeLayout}
            source={source}
            photoUri={photoUri}
            width={viewportWidth}
            onInteractionChange={setDragging}
          />
        ) : null}
        {step === 'cablePattern' ? (
          <>
            <Text>{t('sprayLedSetup.cablePatternHint')}</Text>
            <View style={[styles.row, { gap: spacing[2] }]}>
              {(['horizontal', 'vertical', 'custom'] as const).map((axis) => (
                <ChoiceCard
                  key={axis}
                  label={
                    axis === 'horizontal'
                      ? t('sprayLedSetup.horizontal')
                      : axis === 'vertical'
                        ? t('sprayLedSetup.vertical')
                        : t('sprayLedSetup.customCable')
                  }
                  selected={direction === axis}
                  onPress={() => setDirection(axis)}
                >
                  <CablePatternThumbnail direction={axis} />
                </ChoiceCard>
              ))}
            </View>
          </>
        ) : null}
        {step === 'cableStart' ? (
          <>
            <Text>{t('sprayLedSetup.cableStartHint')}</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing[3] }}>
              {(['tl', 'tr', 'bl', 'br'] as const).map((corner) => (
                <Button
                  key={corner}
                  title={
                    corner === 'tl'
                      ? t('sprayLedSetup.topLeft')
                      : corner === 'tr'
                        ? t('sprayLedSetup.topRight')
                        : corner === 'bl'
                          ? t('sprayLedSetup.bottomLeft')
                          : t('sprayLedSetup.bottomRight')
                  }
                  variant={startCorner === corner ? 'filled' : 'outlined'}
                  onPress={() => setStartCorner(corner)}
                />
              ))}
            </View>
          </>
        ) : null}
        {step === 'initialSkip' ? (
          <>
            <Text>{t('sprayLedSetup.initialSkipHint')}</Text>
            <Text variant="footnote">{t('sprayLedSetup.initialSkipLabel')}</Text>
            <BuilderTextInput
              accessibilityLabel={t('sprayLedSetup.initialSkipLabel')}
              value={initialSkipText}
              onChangeText={setInitialSkipText}
              keyboardType="number-pad"
              maxLength={5}
              selectTextOnFocus
            />
            {!validInitialSkip ? (
              <Text color={brandColors.error}>{t('sprayLedSetup.skipCountRange', { max: skipLimit })}</Text>
            ) : null}
          </>
        ) : null}
        {step === 'holdLeds' || step === 'holdAboveLeds' ? (
          <SprayHoldLedStep
            key={step}
            layer={step === 'holdAboveLeds' ? 'above' : 'primary'}
            wallUuid={wallUuid}
            layout={layout}
            holds={loaded.holds}
            source={source}
            photoUri={photoUri}
            width={viewportWidth}
            onChange={changeLayout}
            onInteractionChange={setDragging}
          />
        ) : null}
        {step === 'lighting' && layout.wiring ? (
          <SprayLedLightingStep
            wallUuid={wallUuid}
            orderedIndices={rowMajorLedIndices(layout.ledPositions ?? [], layout.wiring, layout)}
            layout={layout}
            holds={loaded.holds}
            source={source}
            photoUri={photoUri}
            width={viewportWidth}
            onInteractionChange={setDragging}
          />
        ) : null}
      </View>
    </ScrollView>
  );
}

function PatternCard({
  pattern,
  label,
  selected,
  firstRowOffset = false,
  onPress,
}: {
  pattern: TnutPattern;
  label: string;
  selected: boolean;
  firstRowOffset?: boolean;
  onPress: () => void;
}) {
  return (
    <ChoiceCard label={label} selected={selected} onPress={onPress}>
      <TnutPatternThumbnail pattern={pattern} firstRowOffset={firstRowOffset} />
    </ChoiceCard>
  );
}

function ChoiceCard({
  label,
  selected,
  disabled = false,
  onPress,
  children,
  minimumHeight,
  onMeasureContent,
}: {
  label: string;
  selected: boolean;
  disabled?: boolean;
  onPress: () => void;
  children: ReactNode;
  minimumHeight?: number;
  onMeasureContent?: (height: number) => void;
}) {
  const { systemColors, selection, spacing } = useTheme();
  const content = (
    <>
      <View style={styles.thumbnail}>{children}</View>
      <Text variant="footnote" style={styles.cardLabel}>
        {label}
      </Text>
    </>
  );
  return (
    <PressableSurface
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked: selected, disabled }}
      style={[
        styles.card,
        {
          borderColor: selected ? selection.checkmark : systemColors.separator,
          backgroundColor: selected ? selection.fill : systemColors.secondaryGroupedBackground,
          padding: spacing[2],
          gap: spacing[2],
          minHeight: minimumHeight,
        },
      ]}
    >
      {onMeasureContent ? (
        // Measure natural content, independently of the equal card height. Long
        // translations and Dynamic Type can grow the entire LED grid safely.
        <View onLayout={({ nativeEvent }) => onMeasureContent(nativeEvent.layout.height)} style={{ gap: spacing[2] }}>
          {content}
        </View>
      ) : (
        content
      )}
    </PressableSurface>
  );
}

function CountControl({
  label,
  value,
  onChange,
  maximum = 50,
}: {
  label: string;
  value: string;
  onChange: (text: string) => void;
  maximum?: number;
}) {
  const { t } = useTranslation('boards');
  const { spacing } = useTheme();
  const count = Number(value) || 1;
  return (
    <View style={{ gap: spacing[2] }}>
      <Text variant="headline">{label}</Text>
      <View style={[styles.row, { alignItems: 'center', gap: spacing[3] }]}>
        <Button
          title="−"
          accessibilityLabel={t('sprayLedSetup.decrease', { label })}
          variant="outlined"
          disabled={count <= 1}
          onPress={() => onChange(String(Math.max(1, Math.min(maximum, count - 1))))}
        />
        <View style={styles.countInput}>
          <BuilderTextInput
            value={value}
            onChangeText={onChange}
            accessibilityLabel={label}
            keyboardType={Platform.OS === 'ios' ? 'number-pad' : 'numeric'}
            returnKeyType="done"
            onSubmitEditing={() => Keyboard.dismiss()}
            maxLength={String(maximum).length}
            selectTextOnFocus
          />
        </View>
        <Button
          title="+"
          accessibilityLabel={t('sprayLedSetup.increase', { label })}
          variant="outlined"
          disabled={count >= maximum}
          onPress={() => onChange(String(Math.max(1, Math.min(maximum, count + 1))))}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { width: '100%', maxWidth: 640, alignSelf: 'center' },
  row: { flexDirection: 'row' },
  ledGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  ledCell: { width: '33.333333%' },
  stage: { alignItems: 'center' },
  card: { flex: 1, minWidth: 0, borderWidth: 2, borderRadius: 16 },
  thumbnail: { width: '100%', aspectRatio: 1 },
  cardLabel: { textAlign: 'center' },
  countInput: { flex: 1 },
  fullscreen: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
