import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Alert,
  Keyboard,
  Platform,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
  type ScrollViewInstance,
} from 'react-native';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  DEFAULT_TNUT_CORNERS,
  generateTnutGrid,
  isValidTnutGrid,
  MAX_TNUT_HOLES,
  type Quad,
  type TnutLayout,
  type TnutPattern,
  type TnutPoint,
} from '@boardsesh/spray-wall-geometry';
import { useTheme } from '../../providers/theme-provider';
import { useHeaderActions } from '../../hooks/use-header-actions';
import { useTransparentHeaderInset } from '../../hooks/use-transparent-header-inset';
import { useWindowBottomInset } from '../../hooks/use-window-bottom-inset';
import { useKeyboardHeight } from '../../hooks/use-keyboard-height';
import { useAndroidKeyboardScroll } from '../../hooks/use-android-keyboard-scroll';
import { useAuth } from '../../providers/auth-provider';
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
import { TnutPhotoEditor } from './TnutPhotoEditor';
import { useSprayWizardLeaveGuard } from './use-spray-wizard-leave-guard';

type LoadedSetup = { source: SprayLookPreviewSource; photoUri: string; photoKey: string; saved: TnutLayout | null };
type Step = 'pattern' | 'offset' | 'align' | 'holes' | 'led';

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
          loadSprayWallTnutLayout(wallUuid),
        ]);
        if (!active) return;
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
        const photoKey = JSON.stringify([source.versionId, source.frame.width, source.frame.height, source.homography]);
        if (active) setLoaded({ source, photoUri, photoKey, saved });
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
  return JSON.stringify([layout.pattern, layout.rows, layout.columns, layout.firstRowOffset, layout.corners]);
}

function SetupWizard({ wallUuid, loaded }: { wallUuid: string; loaded: LoadedSetup }) {
  const { t } = useTranslation('boards');
  const { systemColors, brandColors, spacing } = useTheme();
  const router = useRouter();
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
  const window = useWindowDimensions();
  const matchingSaved = loaded.saved?.photoKey === loaded.photoKey ? loaded.saved : null;
  const [photoChanged, setPhotoChanged] = useState(Boolean(loaded.saved && !matchingSaved));
  const [layout, setLayout] = useState<TnutLayout>(() => matchingSaved ?? defaultLayout(loaded.photoKey));
  const [step, setStep] = useState<Step>('pattern');
  useEffect(() => {
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [step]);
  const [rowsText, setRowsText] = useState(String(layout.rows));
  const [columnsText, setColumnsText] = useState(String(layout.columns));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [mode, setMode] = useState<'add' | 'remove'>('add');
  const [history, setHistory] = useState<TnutPoint[][]>([]);
  const [contentWidth, setContentWidth] = useState(0);
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
  const generatedSignature = useRef(matchingSaved ? gridSignature(matchingSaved) : null);
  const parsedRows = Number(rowsText);
  const parsedColumns = Number(columnsText);
  const validCount = (text: string) => /^\d+$/.test(text) && Number(text) >= 1 && Number(text) <= 50;
  const validCounts = validCount(rowsText) && validCount(columnsText);
  const validCorners = isValidTnutGrid({ ...layout, pattern: layout.pattern === 'offset' ? 'offset' : 'grid' });
  const maxWidth = Math.max(0, contentWidth - 44);
  const maxHeight = Math.max(180, Math.min(480, window.height * 0.43));
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

  function changeLayout(update: Partial<TnutLayout>) {
    if (busy.current) return;
    setLayout((previous) => ({ ...previous, ...update }));
    setDirty(true);
    setSaveFailed(false);
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
    if (step === 'offset') setStep('pattern');
    else if (step === 'align') setStep(layout.pattern === 'offset' ? 'offset' : 'pattern');
    else if (step === 'holes') setStep(layout.pattern === 'custom' ? 'pattern' : 'align');
    else if (step === 'led') setStep('holes');
    else router.back();
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
    if (!dirty) {
      leave();
      return;
    }
    Alert.alert(t('sprayLedSetup.discardTitle'), t('sprayLedSetup.discardBody'), [
      { text: t('sprayLedSetup.keepEditing'), style: 'cancel' },
      { text: t('sprayLedSetup.discard'), style: 'destructive', onPress: leave },
    ]);
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
        changeLayout({ ...nextLayout, holes: generateTnutGrid({ ...nextLayout, pattern: layout.pattern }) });
        generatedSignature.current = signature;
        setHistory([]);
      }
      setStep('holes');
      return;
    }
    if (step === 'holes' || step === 'led') {
      if (!layout.holes.length) return;
      if (step === 'led' && !layout.ledPlacement) return;
      busy.current = true;
      setSaving(true);
      setSaveFailed(false);
      try {
        await saveSprayWallTnutLayout(wallUuid, layout);
        if (mounted.current) {
          setDirty(false);
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
    (step !== 'led' || Boolean(layout.ledPlacement));
  useHeaderActions({
    leading: { kind: 'back', onPress: previousStep, accessibilityLabel: t('sprayLedSetup.back'), disabled: saving },
    trailing: {
      label: step === 'led' ? t('sprayLedSetup.done') : t('sprayLedSetup.next'),
      onPress: () => void next(),
      disabled: !canContinue,
    },
    clearOnUnmount: true,
  });

  const tapHole = useCallback(
    (point: TnutPoint, width: number, height: number) => {
      if (busy.current) return;
      let nearest = -1;
      let distance = 18;
      layout.holes.forEach((hole, index) => {
        const candidate = Math.hypot((hole.x - point.x) * width, (hole.y - point.y) * height);
        if (candidate < distance) {
          distance = candidate;
          nearest = index;
        }
      });
      if (mode === 'remove' && nearest < 0) return;
      if (mode === 'add' && (layout.holes.length >= MAX_TNUT_HOLES || distance < 8)) return;
      setHistory((previous) => [...previous.slice(-29), layout.holes]);
      setLayout((previous) => ({
        ...previous,
        holes: mode === 'add' ? [...previous.holes, point] : previous.holes.filter((_, index) => index !== nearest),
      }));
      setDirty(true);
      setSaveFailed(false);
    },
    [layout.holes, mode],
  );

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
            : t('sprayLedSetup.ledTitle');

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
      <View
        style={[styles.content, { gap: spacing[4] }]}
        onLayout={(event) => setContentWidth(event.nativeEvent.layout.width)}
      >
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
                      changeLayout({
                        pattern,
                        holes: [],
                        ledPlacement: layout.ledPlacement === 'alternating' ? undefined : layout.ledPlacement,
                      });
                      setHistory([]);
                      generatedSignature.current = null;
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
                  ? layout.pattern === 'offset' && layout.firstRowOffset
                    ? t('sprayLedSetup.singleInsetRowHint')
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
              value={columnsText}
              onChange={(text) => {
                setColumnsText(text);
                if (validCount(text)) changeLayout({ columns: Number(text) });
              }}
            />
            {!validCounts ? <Text color={brandColors.error}>{t('sprayLedSetup.countRange')}</Text> : null}
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
            <View style={[styles.row, { gap: spacing[3], flexWrap: 'wrap' }]}>
              <Button
                title={t('sprayLedSetup.add')}
                variant={mode === 'add' ? 'filled' : 'outlined'}
                onPress={() => setMode('add')}
                disabled={saving}
              />
              <Button
                title={t('sprayLedSetup.remove')}
                variant={mode === 'remove' ? 'filled' : 'outlined'}
                onPress={() => setMode('remove')}
                disabled={saving}
              />
              <Button
                title={t('sprayLedSetup.undo')}
                variant="text"
                disabled={!history.length || saving}
                onPress={() => {
                  const previous = history[history.length - 1];
                  if (previous) {
                    changeLayout({ holes: previous });
                    setHistory((entries) => entries.slice(0, -1));
                  }
                }}
              />
            </View>
            <View style={styles.stage}>
              <TnutPhotoEditor
                source={source}
                photoUri={photoUri}
                holes={layout.holes}
                maxWidth={maxWidth}
                maxHeight={maxHeight}
                onTap={tapHole}
              />
            </View>
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
            <View style={[styles.row, { gap: spacing[2] }]}>
              {(['center', 'sides', 'below'] as const).map((placement) => (
                <ChoiceCard
                  key={placement}
                  label={
                    placement === 'center'
                      ? t('sprayLedSetup.ledCenter')
                      : placement === 'sides'
                        ? t('sprayLedSetup.ledSides')
                        : t('sprayLedSetup.ledBelow')
                  }
                  selected={layout.ledPlacement === placement}
                  disabled={saving}
                  onPress={() => changeLayout({ ledPlacement: placement })}
                >
                  <LedPlacementThumbnail placement={placement} />
                </ChoiceCard>
              ))}
            </View>
            {layout.pattern === 'offset' ? (
              <View style={[styles.row, { gap: spacing[2], alignItems: 'center' }]}>
                <ChoiceCard
                  label={t('sprayLedSetup.ledAlternating')}
                  selected={layout.ledPlacement === 'alternating'}
                  disabled={saving}
                  onPress={() => changeLayout({ ledPlacement: 'alternating' })}
                >
                  <LedPlacementThumbnail placement="alternating" firstRowOffset={layout.firstRowOffset} />
                </ChoiceCard>
                <View style={{ flex: 2 }}>
                  <Text variant="footnote">{t('sprayLedSetup.ledAlternatingHint')}</Text>
                </View>
              </View>
            ) : null}
            <Text variant="footnote">{t('sprayLedSetup.ledSetupPending')}</Text>
            <Text variant="footnote" color={systemColors.secondaryLabel}>
              {t('sprayLedSetup.localHint')}
            </Text>
          </>
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
}: {
  label: string;
  selected: boolean;
  disabled?: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  const { systemColors, brandColors, spacing } = useTheme();
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
          borderColor: selected ? brandColors.primary : systemColors.separator,
          backgroundColor: systemColors.secondaryGroupedBackground,
          padding: spacing[2],
          gap: spacing[2],
        },
      ]}
    >
      <View style={styles.thumbnail}>{children}</View>
      <Text variant="footnote" style={styles.cardLabel}>
        {label}
      </Text>
    </PressableSurface>
  );
}

function CountControl({ label, value, onChange }: { label: string; value: string; onChange: (text: string) => void }) {
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
          onPress={() => onChange(String(Math.max(1, Math.min(50, count - 1))))}
        />
        <View style={styles.countInput}>
          <BuilderTextInput
            value={value}
            onChangeText={onChange}
            accessibilityLabel={label}
            keyboardType={Platform.OS === 'ios' ? 'number-pad' : 'numeric'}
            returnKeyType="done"
            onSubmitEditing={() => Keyboard.dismiss()}
            maxLength={3}
            selectTextOnFocus
          />
        </View>
        <Button
          title="+"
          accessibilityLabel={t('sprayLedSetup.increase', { label })}
          variant="outlined"
          disabled={count >= 50}
          onPress={() => onChange(String(Math.max(1, Math.min(50, count + 1))))}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { width: '100%', maxWidth: 640, alignSelf: 'center' },
  row: { flexDirection: 'row' },
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
