// Background, then illuminated holds: the add-a-wall flow's two look steps.
//
// Between the editor's commit and the details: the holds are on the draft, so
// this is the first moment the wall can be drawn the way its climbers will see
// it. The creator first picks a wall background, then swipes through hold
// looks drawn on THEIR wall with some of its own holds lit, and the pick is
// stored on the wall (`setSprayWallRenderSettings`) before the details step.
// Every climber then sees the wall this way, unless they turned on "Use my look
// on spray walls" (`boardLookForRender`).
//
// Both phases are settings-style forms under a short header (the step counter,
// the question, one line), in the shape of Settings → Board
// (`settings/board-look/BoardLookScreen.tsx`): the preview is a fixed-height
// row, the choice a native control under it.
//
// Mandatory, like the onboarding step it mirrors: there is no Skip, because
// skipping would silently store nothing and the wall would draw in whatever the
// app default happens to be — the silence a choice step exists to end. The
// suggested background and default hold look can each be kept with Next.
//
// The one way past without a stored look is a FAILED save. The look is the only
// thing this step adds; a backend that cannot store it yet (the app and the
// backend ship on different trains), or a save that keeps failing, must not keep
// a finished wall from being published.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Platform,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Text } from '../Text';
import { Button } from '../Button';
import { MoreFormRN } from '../MoreForm.rn';
import { LookOptionSlider } from '../LookOptionSlider';
import { ValueSlider } from '../ValueSlider';
import { adjustValue, notchIndex } from '../value-slider.logic';
import { ActivityIndicator } from '../ActivityIndicator';
import { BoardLookCarousel } from '../board-look/BoardLookCarousel';
import { RailIndexDots } from '../board-look/RailIndexDots';
import {
  captionBlockHeight,
  captionLineHeights,
  RAIL_MIN_WIDTH,
  RAIL_THUMB_HEIGHT,
} from '../board-look/board-look-card-metrics';
import { useTheme } from '../../providers/theme-provider';
import { useTransparentHeaderInset } from '../../hooks/use-transparent-header-inset';
import { useHeaderActions } from '../../hooks/use-header-actions';
import { useWindowBottomInset } from '../../hooks/use-window-bottom-inset';
import { opacity, spacing } from '../../theme/tokens';
import { hapticSelection } from '../../lib/haptics';
import { reportError } from '../../lib/error-reporting';
import { useEffectiveBoardRenderSettings } from '../../hooks/use-native-climb-render';
import { useSyntheticSprayWallPreview } from '../../hooks/use-synthetic-spray-wall-preview';
import {
  DEFAULT_SPRAY_WALL_LOOK_OPTION_ID,
  SPRAY_WALL_DIM_RANGE,
  SPRAY_WALL_DIM_STEP,
  SPRAY_WALL_LOOK_OPTIONS,
  boardLookOptionWallDefault,
  sprayWallDimLevel,
  withSprayWallDim,
  type BoardLookOptionId,
} from '../../lib/board-render/board-look-options';
import { useKeepSprayDraftRegistered, useSprayWallDraft } from '../../lib/spray/use-spray-wall-draft';
import { useSetSprayWallRenderSettings } from '../../lib/spray/use-create-spray-wall';
import type { CreatedWallDraft } from './add-wall-machine';
import { fitSprayLookHero } from './spray-look-hero';
import { useSprayWallArt } from '../../lib/spray/use-spray-wall-art';
import type { SprayWallBackground } from '../../lib/spray/spray-wall-background';
import {
  isSprayWallArtNotAvailableError,
  readSprayWallArtRefusalReason,
} from '../../lib/graphql/extract-error-message';
import { SprayWallBackgroundCarousel } from './SprayWallBackgroundCarousel';
import { StepCounter } from './StepCounter';
import { buildSprayBackgroundModel, buildSprayLookModel } from './spray-look-model';
import {
  canPickBackground,
  sprayArtRefusalMessageKey,
  sprayBackgroundGate,
  suggestedBackground,
} from './spray-background-gate';

// Plain numbers, so the worklets below capture numbers rather than a shared object.
const DIM_MIN = SPRAY_WALL_DIM_RANGE.min;
const DIM_MAX = SPRAY_WALL_DIM_RANGE.max;
const DIM_STEP = SPRAY_WALL_DIM_STEP;
const DIM_STEPS_PER_UNIT = Math.round(1 / SPRAY_WALL_DIM_STEP);

// Worklets: the slider runs these inside its gesture, on every frame. Rounded
// through whole steps so 0.15 is 0.15, not 0.15000000000000002.
function roundDim(raw: number): number {
  'worklet';
  return Math.round(raw * DIM_STEPS_PER_UNIT) / DIM_STEPS_PER_UNIT;
}

function dimNotch(value: number): number {
  'worklet';
  return notchIndex(value, DIM_STEP);
}

function adjustDim(value: number, direction: 1 | -1): number {
  'worklet';
  return adjustValue(value, direction * DIM_STEP, DIM_MIN, DIM_MAX, roundDim);
}

/** The rail row's dots: 6 pt plus the padding `RailIndexDots` puts under them, and a gap above. */
const DOTS_HEIGHT = 6 + spacing[3] + spacing[2];
/** What a form spends around the preview row: section spacing above it, insets around it. */
const FORM_CHROME = spacing[8];
/** The dim slider's section: its label line, its track and the gap above them. */
const DIM_SECTION_HEIGHT = 112;
/** The preview row is never squeezed below this; past it, the form scrolls. */
const MIN_PREVIEW_ROW = 280;
/** Nor drawn taller than this, on a tablet. */
const MAX_PREVIEW_ROW = 640;

/**
 * What the climber chose on the two look phases, handed to the wizard on
 * confirm so that Back from the details step can reopen the look as it was.
 */
export type SprayLookChoice = {
  selectedId: BoardLookOptionId;
  /** The dim slider's value, or null when it was never touched. */
  dim: number | null;
  background: SprayWallBackground;
  backgroundTouched: boolean;
};

type SprayWallLookStepProps = {
  draft: CreatedWallDraft;
  stepCounter: string;
  phase: 'background' | 'look';
  /** The header's forward label for this phase: "Next", or "Save" where the look is the last step. */
  forwardLabel: string;
  /** The way past a failed save: "Keep going anyway", or "Publish anyway" where publishing is next. */
  confirmWithoutLabel: string;
  /** What a failed save says, naming that same way past it. */
  saveFailedMessage: string;
  /** The choice confirmed earlier in this run, when the climber came back to change it. */
  initialChoice?: SprayLookChoice;
  onBackgroundConfirmed: () => void;
  /**
   * The save is in flight. The flow treats it as busy, so nothing can leave
   * under it: a Leave answered mid-save would pop the route, then the save's
   * success would publish the wall the climber walked away from.
   */
  onSaveStarted: () => void;
  /** The save failed; the step offers a retry and a way past (`confirmWithoutLabel`). */
  onSaveFailed: () => void;
  /** The look is stored on the wall, or the climber chose to go on without it. */
  onConfirmed: (choice: SprayLookChoice) => void;
  /**
   * One more line under the body, said before publishing: a reset's step uses
   * it to say the wall it replaces is archived when this one goes live.
   */
  notice?: string;
};

export function SprayWallLookStep({
  draft,
  stepCounter,
  phase,
  forwardLabel,
  confirmWithoutLabel,
  saveFailedMessage,
  initialChoice,
  onBackgroundConfirmed,
  onSaveStarted,
  onSaveFailed,
  onConfirmed,
  notice,
}: SprayWallLookStepProps) {
  const { t } = useTranslation('boards');
  const { t: tCommon } = useTranslation('common');
  const { systemColors, textStyles } = useTheme();
  const bottomInset = useWindowBottomInset();
  const headerInset = useTransparentHeaderInset();
  const { width: windowWidth, fontScale } = useWindowDimensions();
  const savingRef = useRef(false);
  const [localSaving, setLocalSaving] = useState(false);

  // The draft in the registry, so the preview below has a wall to draw. A wall
  // being created has no published version, and the editor's teardown only
  // reloads a published one, so it no longer clears this draft on its way out;
  // nor does a published-wall load that finds nothing published
  // (`settleSprayWallRenderMiss`). The second hook re-registers the draft from
  // the cached payload whenever the registry holds anything else, e.g. after a
  // withdrawal of this wall followed by a fresh read.
  const draftState = useSprayWallDraft(draft.layoutId, draft.wallUuid, draft.versionNumber, draft.versionId);
  useKeepSprayDraftRegistered(draft.layoutId, draft.wallUuid, draft.versionNumber, draft.versionId);

  const { status: previewStatus, preview } = useSyntheticSprayWallPreview(draft.layoutId);
  const { boardseshRendererAvailable } = useEffectiveBoardRenderSettings();

  // How hard the rest of the wall is dimmed. `null` until the creator touches
  // the slider: each preset keeps its own look's dimming, and the slider shows
  // the selected one's. Once touched, the value applies to every look that has
  // a veil, in the previews and in what is stored. Committed on release only:
  // during a drag only the selected card follows the live value, so a drag
  // redraws one card rather than the whole rail; the save uses that card.
  const [dim, setDim] = useState<number | null>(initialChoice?.dim ?? null);
  const [liveDim, setLiveDim] = useState<number | null>(null);

  // Every look stays offered even when THIS phone cannot draw Aura: the pick
  // is stored for every climber on the wall, and one creator's binary (or a
  // runtime fallback that latched its renderer off) must not turn it into a
  // wall-wide Classic. An unsupported selected look shows a skeleton, and the
  // default stays the spray look.
  const options = useMemo(() => withSprayWallDim(SPRAY_WALL_LOOK_OPTIONS, dim), [dim]);

  // Local until Next: a swipe only moves the selection, and the one write
  // happens on the button.
  const [selectedId, setSelectedId] = useState<BoardLookOptionId>(
    initialChoice?.selectedId ?? DEFAULT_SPRAY_WALL_LOOK_OPTION_ID,
  );
  // Every other card keeps its option's identity, so only the selected one
  // re-renders as the dim slider moves.
  const previewOptions = useMemo(
    () =>
      liveDim === null
        ? options
        : options.map((option) =>
            option.id === selectedId ? (withSprayWallDim([option], liveDim)[0] ?? option) : option,
          ),
    [options, liveDim, selectedId],
  );
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.id === selectedId),
  );
  const selectedOption = options[selectedIndex] ?? options[0];
  // `null` for Classic, which draws no veil, so the slider goes away there.
  const selectedDim = selectedOption ? sprayWallDimLevel(selectedOption) : null;
  const shownDim = liveDim ?? selectedDim ?? 0;

  // Rounded through whole steps: a native slider hands back 0.15000000000000002.
  const commitDim = useCallback((value: number) => {
    if (savingRef.current) return;
    setLiveDim(null);
    setDim(roundDim(value));
  }, []);
  const cancelDim = useCallback(() => {
    if (!savingRef.current) setLiveDim(null);
  }, []);
  const previewDim = useCallback((value: number) => {
    if (!savingRef.current) setLiveDim(roundDim(value));
  }, []);
  const formatDim = useCallback(
    (value: number) =>
      value <= 0
        ? t('sprayWizard.look.dimOff')
        : tCommon('mobile.settings.boardLook.glowVeil.veilOpacity.value', { value: Math.round(value * 100) }),
    [t, tCommon],
  );

  // The form's preview row is pinned in points by a native host before React
  // Native lays it out (`MoreCustomRow.height`), so its height is worked out
  // here, from the room measured under the header block: the header grows
  // with the locale and the text size.
  // Measured on the form's own slot, under the header block, so neither the
  // see-through bar's inset nor the header's copy is counted twice.
  const [formHeight, setFormHeight] = useState(0);
  const handleFormLayout = useCallback((event: LayoutChangeEvent) => {
    setFormHeight(event.nativeEvent.layout.height);
  }, []);
  const [reservedLookHeight, setReservedLookHeight] = useState<number | null>(null);
  const [reservedBackgroundHeight, setReservedBackgroundHeight] = useState<number | null>(null);
  const handleReservedLookHeight = useCallback((height: number) => {
    setReservedLookHeight((previous) => (previous !== null && Math.abs(previous - height) < 0.5 ? previous : height));
  }, []);
  const handleReservedBackgroundHeight = useCallback((height: number) => {
    setReservedBackgroundHeight((previous) =>
      previous !== null && Math.abs(previous - height) < 0.5 ? previous : height,
    );
  }, []);
  const minimumCompactHeight =
    RAIL_THUMB_HEIGHT + captionBlockHeight(captionLineHeights('rail', textStyles), fontScale, 0) + DOTS_HEIGHT;
  const lookReservedHeight = reservedLookHeight ?? (selectedDim !== null ? DIM_SECTION_HEIGHT : 0);
  const lookRowHeight = Math.round(
    Math.min(MAX_PREVIEW_ROW, Math.max(minimumCompactHeight, formHeight - lookReservedHeight)),
  );
  // Ordinary phones keep the preview still while dimming. A tiny viewport or
  // accessibility text can still scroll once a readable compact card cannot fit.
  const lookOverflows = lookRowHeight + lookReservedHeight > formHeight + 0.5;
  const backgroundReservedHeight = reservedBackgroundHeight ?? FORM_CHROME * 3;
  const backgroundRowHeight = Math.round(
    Math.min(MAX_PREVIEW_ROW, Math.max(MIN_PREVIEW_ROW, formHeight - backgroundReservedHeight)),
  );
  const backgroundOverflows = backgroundRowHeight + backgroundReservedHeight > formHeight + 0.5;

  // The row is inset inside the form's card, so the rail centres on the row,
  // not the window. Measured inside the row; until then, the window less the
  // form's usual side insets.
  const [rowWidth, setRowWidth] = useState(0);
  const handleRowLayout = useCallback((event: LayoutChangeEvent) => {
    setRowWidth(event.nativeEvent.layout.width);
  }, []);
  const railWidth = rowWidth > 0 ? rowWidth : Math.max(0, windowWidth - spacing[4] * 2);

  const previewAspect = preview ? preview.boardWidth / preview.boardHeight : null;
  const heroThumb = useMemo(() => {
    if (formHeight <= 0 || previewAspect == null) return null;
    return fitSprayLookHero({
      aspect: previewAspect,
      windowWidth: railWidth,
      railSlotHeight: Math.max(0, lookRowHeight - DOTS_HEIGHT),
      captionLineHeights: captionLineHeights('hero', textStyles),
      fontScale,
      verticalPadding: 0,
      minWidth: RAIL_MIN_WIDTH,
    });
  }, [formHeight, previewAspect, railWidth, lookRowHeight, textStyles, fontScale]);

  // The server decides which backgrounds this draft can save. Loading,
  // unsupported and refused gates offer only the photo; unsupported backends
  // receive no new background key.
  const artQuery = useSprayWallArt(draft.wallUuid, draft.versionNumber);
  const backgroundGate = useMemo(
    () => sprayBackgroundGate({ status: artQuery.status, art: artQuery.data }),
    [artQuery.status, artQuery.data],
  );
  const [background, setBackground] = useState<SprayWallBackground>(initialChoice?.background ?? 'photo');
  const [backgroundTouched, setBackgroundTouched] = useState(initialChoice?.backgroundTouched ?? false);
  // "Wall only" is the suggestion once the photo passes, until the creator picks.
  useEffect(() => {
    if (!backgroundTouched) setBackground(suggestedBackground(backgroundGate));
  }, [backgroundGate, backgroundTouched]);
  const pickBackground = useCallback((next: SprayWallBackground) => {
    if (savingRef.current) return;
    setBackgroundTouched(true);
    setBackground(next);
  }, []);

  const setRenderSettings = useSetSprayWallRenderSettings();
  const setRenderSettingsAsync = setRenderSettings.mutateAsync;
  const saving = setRenderSettings.isPending || localSaving;
  const [saveError, setSaveError] = useState<string | null>(null);

  const handleContinue = useCallback(async () => {
    if (savingRef.current || saving || phase !== 'look' || !selectedOption) return;
    const look = boardLookOptionWallDefault(selectedOption.id, previewOptions);
    if (!look) return;
    // `background` only to a backend that answered `sprayWallArt` (an older one
    // refuses the key), and only for a generated look or a photo the creator
    // picked by hand: an omitted key keeps whatever an earlier save stored.
    const backendKnowsBackgrounds = backgroundGate.kind === 'open' || backgroundGate.kind === 'locked';
    const sentBackground = canPickBackground(backgroundGate, background) ? background : 'photo';
    const renderSettings =
      backendKnowsBackgrounds && (sentBackground !== 'photo' || backgroundTouched)
        ? { ...look, background: sentBackground }
        : look;
    savingRef.current = true;
    setLocalSaving(true);
    hapticSelection();
    setSaveError(null);
    onSaveStarted();
    AccessibilityInfo.announceForAccessibility(t('sprayWizard.look.saving'));
    try {
      await setRenderSettingsAsync({ layoutId: draft.layoutId, uuid: draft.wallUuid, renderSettings });
      onConfirmed({ selectedId: selectedOption.id, dim, background, backgroundTouched });
    } catch (error) {
      reportError(error);
      onSaveFailed();
      // Our own words, never the server's: the likeliest failure is a backend
      // that predates the field, whose message is schema jargon. A photo the
      // server will not flatten gets its own sentence, and the picker goes back
      // to the photo so a retry stores a look that can be shown.
      const artRefused = isSprayWallArtNotAvailableError(error);
      if (artRefused) {
        setBackgroundTouched(true);
        setBackground('photo');
      }
      const message = artRefused
        ? t(`sprayBackground.${sprayArtRefusalMessageKey(readSprayWallArtRefusalReason(error))}`)
        : saveFailedMessage;
      setSaveError(message);
      // `accessibilityLiveRegion` below is Android-only; VoiceOver needs telling.
      AccessibilityInfo.announceForAccessibility(message);
    } finally {
      savingRef.current = false;
      setLocalSaving(false);
    }
  }, [
    saving,
    selectedOption,
    previewOptions,
    phase,
    setRenderSettingsAsync,
    draft.layoutId,
    draft.wallUuid,
    onSaveStarted,
    onSaveFailed,
    onConfirmed,
    t,
    saveFailedMessage,
    background,
    backgroundGate,
    backgroundTouched,
    dim,
  ]);

  const fallbackOptions = useMemo(
    () => options.map((option) => ({ id: option.id, label: tCommon(option.labelI18nKey) })),
    [options, tCommon],
  );
  const selectFallbackLook = useCallback(
    (id: string) => {
      if (savingRef.current || saving) return;
      const option = options.find((candidate) => candidate.id === id);
      if (option) setSelectedId(option.id);
    },
    [saving, options],
  );

  const displayedBackground = canPickBackground(backgroundGate, background) ? background : 'photo';
  const backgroundLabel =
    displayedBackground === 'photo'
      ? t('sprayBackground.photo')
      : displayedBackground === 'wall-crop'
        ? t('sprayBackground.wallCrop')
        : t('sprayBackground.holdCutouts');
  const confirmWithout = useCallback(() => {
    if (!savingRef.current && !saving) {
      onConfirmed({ selectedId: selectedOption?.id ?? selectedId, dim, background, backgroundTouched });
    }
  }, [saving, onConfirmed, selectedOption, selectedId, dim, background, backgroundTouched]);

  // The wizard names the forward action ("Next", or "Save" on a reset's last
  // step): text, not the ✓.
  // The X stays leading: from here on, leaving keeps the draft.
  useHeaderActions({
    trailing: {
      kind: 'forward',
      label: forwardLabel,
      onPress: phase === 'background' ? onBackgroundConfirmed : () => void handleContinue(),
      loading: saving,
      disabled: saving,
      prominent: true,
    },
  });

  const lookNotes = useMemo(() => {
    const notes: string[] = [];
    if (displayedBackground !== 'photo')
      notes.push(t('sprayWizard.look.previewPhoto', { background: backgroundLabel }));
    if (notice) notes.push(notice);
    return notes;
  }, [displayedBackground, backgroundLabel, notice, t]);

  const selectedCardId = selectedOption?.id ?? selectedId;
  // The rail and its dots, as one fixed-height row. Memoised: the form model
  // rebuilds on every dim frame, and the rail must not re-render with it.
  const carousel = useMemo(
    () =>
      preview ? (
        <View style={styles.rail} onLayout={handleRowLayout} testID="spray-look-carousel">
          <View style={styles.railCards}>
            <BoardLookCarousel
              options={previewOptions}
              selectedId={selectedCardId}
              onSelect={selectFallbackLook}
              preview={preview}
              boardseshRendererAvailable={boardseshRendererAvailable}
              heroThumb={heroThumb}
              windowWidth={railWidth}
              centered
              // Safe here: a snap only moves local state until Next.
              selectOnSnap
              showDescriptions={false}
            />
          </View>
          <RailIndexDots count={previewOptions.length} activeIndex={selectedIndex} />
        </View>
      ) : null,
    [
      preview,
      handleRowLayout,
      previewOptions,
      selectedCardId,
      selectFallbackLook,
      boardseshRendererAvailable,
      heroThumb,
      railWidth,
      selectedIndex,
    ],
  );

  const lookModel = useMemo(
    () =>
      buildSprayLookModel({
        t,
        carousel,
        carouselHeight: lookRowHeight,
        notes: lookNotes,
        saveError,
        confirmWithoutLabel,
        onConfirmWithout: confirmWithout,
        saving,
        dim:
          selectedDim === null
            ? null
            : {
                value: shownDim,
                min: DIM_MIN,
                max: DIM_MAX,
                step: DIM_STEP,
                format: formatDim,
                onValueChange: previewDim,
                onCommit: commitDim,
              },
      }),
    [
      t,
      carousel,
      lookRowHeight,
      lookNotes,
      saveError,
      confirmWithoutLabel,
      confirmWithout,
      saving,
      selectedDim,
      shownDim,
      formatDim,
      previewDim,
      commitDim,
    ],
  );

  const backgroundPreview = useMemo(
    () => (
      <SprayWallBackgroundCarousel
        gate={backgroundGate}
        value={displayedBackground}
        previewSource={draftState.lookPreviewSource}
        unavailable={draftState.isUnavailable}
        disabled={saving || backgroundGate.kind === 'loading'}
        height={backgroundRowHeight}
        onChange={pickBackground}
      />
    ),
    [
      backgroundGate,
      displayedBackground,
      draftState.lookPreviewSource,
      draftState.isUnavailable,
      saving,
      backgroundRowHeight,
      pickBackground,
    ],
  );
  const backgroundModel = useMemo(
    () =>
      buildSprayBackgroundModel({
        t,
        preview: backgroundPreview,
        previewHeight: backgroundRowHeight,
        gate: backgroundGate,
        value: background,
        unavailable: draftState.isUnavailable,
      }),
    [t, backgroundPreview, backgroundRowHeight, backgroundGate, background, draftState.isUnavailable],
  );

  // A form only once the room for it is measured: its preview row is pinned
  // in points, and a first guess would re-fit the rail a frame later.
  const measured = formHeight > 0;
  const showsLookForm = phase === 'look' && preview != null;

  const content = (
    <View
      style={[
        styles.root,
        // Padded rather than offset, so the grouped background runs up under
        // the see-through header instead of leaving a seam below it.
        { paddingTop: headerInset, backgroundColor: systemColors.groupedBackground },
        { paddingBottom: (Platform.OS === 'android' ? 0 : bottomInset) + spacing[3] },
      ]}
      testID={phase === 'background' ? 'spray-background-step' : 'spray-look-step'}
    >
      <View style={styles.header}>
        <StepCounter label={stepCounter} />
        <View style={styles.titleBlock}>
          <Text variant="title3">
            {phase === 'background' ? t('sprayWizard.background.title') : t('sprayWizard.look.title')}
          </Text>
          <Text variant="subheadline" color={systemColors.secondaryLabel}>
            {phase === 'background' ? t('sprayWizard.background.body') : t('sprayWizard.look.body')}
          </Text>
        </View>
      </View>

      {/* Nothing in the form may change under a save in flight. */}
      <View
        style={[styles.form, saving ? styles.saving : null]}
        pointerEvents={saving ? 'none' : 'auto'}
        onLayout={handleFormLayout}
        testID="spray-look-form"
      >
        {phase === 'background' ? (
          measured ? (
            <MoreFormRN
              model={backgroundModel}
              fitted
              scrollable={backgroundOverflows}
              onReservedHeightChange={handleReservedBackgroundHeight}
            />
          ) : null
        ) : showsLookForm ? (
          measured ? (
            <MoreFormRN
              model={lookModel}
              fitted
              scrollable={lookOverflows}
              onReservedHeightChange={handleReservedLookHeight}
            />
          ) : null
        ) : (
          // No preview to swipe through (still loading, or the draft cannot be
          // drawn here): the looks by name, and the dim slider, so a look can
          // still be picked and saved.
          <ScrollView contentContainerStyle={styles.fallback} showsVerticalScrollIndicator>
            {saveError ? (
              <View style={styles.saveError}>
                <Text variant="subheadline" color={systemColors.error} accessibilityLiveRegion="polite">
                  {saveError}
                </Text>
                <Button
                  title={confirmWithoutLabel}
                  variant="text"
                  size="small"
                  onPress={confirmWithout}
                  disabled={saving}
                />
              </View>
            ) : null}
            {lookNotes.map((line) => (
              <Text key={line} variant="footnote" color={systemColors.secondaryLabel}>
                {line}
              </Text>
            ))}
            <View style={styles.placeholder}>
              {draftState.isStalled || draftState.isUnavailable || previewStatus === 'unavailable' ? (
                <>
                  <Text
                    variant="subheadline"
                    color={systemColors.secondaryLabel}
                    style={styles.centered}
                    accessibilityLiveRegion="polite"
                  >
                    {draftState.isStalled ? t('sprayEditor.loadStalled') : t('sprayWizard.look.unavailable')}
                  </Text>
                  <Button
                    title={t('sprayWizard.review.retry')}
                    variant="text"
                    size="small"
                    onPress={draftState.retry}
                    disabled={saving}
                    testID="spray-look-retry"
                  />
                </>
              ) : (
                <>
                  <ActivityIndicator />
                  <Text variant="subheadline" color={systemColors.secondaryLabel} accessibilityLiveRegion="polite">
                    {t('sprayWizard.look.loading')}
                  </Text>
                </>
              )}
            </View>
            <LookOptionSlider
              options={fallbackOptions}
              value={selectedId}
              onChange={selectFallbackLook}
              accessibilityLabel={t('sprayWizard.look.title')}
              disabled={saving}
              testID="spray-hold-look-slider"
            />
            {selectedDim !== null ? (
              <View style={styles.dim}>
                <View style={styles.dimLabels}>
                  <Text variant="subheadline">{t('sprayWizard.look.dimTitle')}</Text>
                  <Text variant="subheadline" color={systemColors.secondaryLabel}>
                    {formatDim(shownDim)}
                  </Text>
                </View>
                <ValueSlider
                  value={selectedDim}
                  min={DIM_MIN}
                  max={DIM_MAX}
                  round={roundDim}
                  notch={dimNotch}
                  format={formatDim}
                  accessibilityLabel={t('sprayWizard.look.dimTitle')}
                  adjust={adjustDim}
                  disabled={saving}
                  onLiveChange={previewDim}
                  onCommit={commitDim}
                  onCancel={cancelDim}
                  testID="spray-look-dim-slider"
                />
              </View>
            ) : null}
          </ScrollView>
        )}
      </View>
    </View>
  );

  return Platform.OS === 'android' ? (
    <SafeAreaProvider style={styles.root}>
      <SafeAreaView edges={['bottom']} style={styles.root}>
        {content}
      </SafeAreaView>
    </SafeAreaProvider>
  ) : (
    content
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  header: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[4],
    paddingBottom: spacing[1],
    gap: spacing[1],
  },
  // The question and the line under it.
  titleBlock: {
    gap: spacing[1],
  },
  form: {
    flex: 1,
  },
  // Nothing moves under a save in flight, and the form says so.
  saving: {
    opacity: opacity.disabled,
  },
  rail: {
    flex: 1,
  },
  railCards: {
    flex: 1,
    justifyContent: 'center',
  },
  fallback: {
    flexGrow: 1,
    padding: spacing[4],
    gap: spacing[3],
  },
  placeholder: {
    alignItems: 'center',
    gap: spacing[3],
    paddingVertical: spacing[6],
  },
  dim: {
    gap: spacing[2],
  },
  dimLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: spacing[2],
  },
  centered: {
    textAlign: 'center',
  },
  saveError: {
    alignItems: 'flex-start',
    gap: spacing[1],
  },
});
