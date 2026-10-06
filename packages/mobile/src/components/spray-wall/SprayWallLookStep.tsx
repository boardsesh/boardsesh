// "How should your holds light up?" — the add-a-wall flow's look step.
//
// Between the editor's commit and the publish: the holds are on the draft, so
// this is the first moment the wall can be drawn the way its climbers will see
// it. The creator swipes the same looks the onboarding board-look step offers,
// each drawn on THEIR wall with some of its own holds lit, and the pick is stored
// on the wall (`setSprayWallRenderSettings`) before it publishes. Every climber
// then sees the wall this way, unless they turned on "Use my look on spray
// walls" (`boardLookForRender`).
//
// Mandatory, like the onboarding step it mirrors: there is no Skip, because
// skipping would silently store nothing and the wall would draw in whatever the
// app default happens to be — the silence a choice step exists to end. The
// default selection (`DEFAULT_SPRAY_WALL_LOOK_OPTION_ID`) is one tap away, so the
// step costs a climber who does not care exactly one tap.
//
// The one way past without a stored look is a FAILED save. The look is the only
// thing this step adds; a backend that cannot store it yet (the app and the
// backend ship on different trains), or a save that keeps failing, must not keep
// a finished wall from being published.

import { useCallback, useMemo, useState } from 'react';
import {
  AccessibilityInfo,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Button } from '../Button';
import { RadioGroup } from '../RadioGroup';
import { ValueSlider } from '../ValueSlider';
import { adjustValue, notchIndex } from '../value-slider.logic';
import { ActivityIndicator } from '../ActivityIndicator';
import { BoardLookCarousel } from '../board-look/BoardLookCarousel';
import { RailIndexDots } from '../board-look/RailIndexDots';
import { captionLineHeights } from '../board-look/board-look-card-metrics';
import { useTheme } from '../../providers/theme-provider';
import { useTransparentHeaderInset } from '../../hooks/use-transparent-header-inset';
import { spacing } from '../../theme/tokens';
import { iosSystemColors } from '../../theme/ios-colors';
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

type SprayWallLookStepProps = {
  draft: CreatedWallDraft;
  stepCounter: string;
  /**
   * The save is in flight. The flow treats it as busy, so nothing can leave
   * under it: a Leave answered mid-save would pop the route, then the save's
   * success would publish the wall the climber walked away from.
   */
  onSaveStarted: () => void;
  /** The save failed; the step offers a retry and "Publish anyway". */
  onSaveFailed: () => void;
  /** The look is stored on the wall, or the climber chose to publish without it. */
  onConfirmed: () => void;
  /**
   * One more line under the body, said before publishing: a reset's step uses
   * it to say the wall it replaces is archived when this one goes live.
   */
  notice?: string;
};

export function SprayWallLookStep({
  draft,
  stepCounter,
  onSaveStarted,
  onSaveFailed,
  onConfirmed,
  notice,
}: SprayWallLookStepProps) {
  const { t } = useTranslation('boards');
  const { t: tCommon } = useTranslation('common');
  const { systemColors, textStyles } = useTheme();
  const insets = useSafeAreaInsets();
  const headerInset = useTransparentHeaderInset();
  const { width: windowWidth, fontScale } = useWindowDimensions();

  // The draft back in the registry. The editor's own `useSprayWallDraft`
  // unregistered it on its way out — its teardown reloads the PUBLISHED wall,
  // which a wall being created does not have — so the preview below would have
  // nothing to draw. The second hook holds it there against that reload, which
  // is async and can land after this screen's own registration.
  const draftState = useSprayWallDraft(draft.layoutId, draft.wallUuid, draft.versionNumber, draft.versionId);
  useKeepSprayDraftRegistered(draft.layoutId, draft.wallUuid, draft.versionNumber, draft.versionId);

  const { status: previewStatus, preview } = useSyntheticSprayWallPreview(draft.layoutId);
  const { boardseshRendererAvailable } = useEffectiveBoardRenderSettings();

  // How hard the rest of the wall is dimmed. `null` until the creator touches
  // the slider: each card keeps its own look's dimming, and the slider shows
  // the selected one's. Once touched, the value applies to every look that has
  // a veil, in the previews and in what is stored. Committed on release only:
  // every committed value redraws every card.
  const [dim, setDim] = useState<number | null>(null);
  const [liveDim, setLiveDim] = useState<number | null>(null);

  // Every look stays offered even when THIS phone cannot draw Aura: the pick
  // is stored for every climber on the wall, and one creator's binary (or a
  // runtime fallback that latched its renderer off) must not turn it into a
  // wall-wide Classic. Those cards show as placeholders here (the carousel's
  // own skeleton), and the default stays the spray look.
  const options = useMemo(() => withSprayWallDim(SPRAY_WALL_LOOK_OPTIONS, dim), [dim]);

  // Local until Continue: a carousel tap only moves the selection, and the one
  // write happens on the button.
  const [selectedId, setSelectedId] = useState<BoardLookOptionId>(DEFAULT_SPRAY_WALL_LOOK_OPTION_ID);
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.id === selectedId),
  );
  const selectedOption = options[selectedIndex] ?? options[0];
  // `null` for Classic, which draws no veil, so the slider goes away there.
  const selectedDim = selectedOption ? sprayWallDimLevel(selectedOption) : null;
  const shownDim = liveDim ?? selectedDim ?? 0;

  const commitDim = useCallback((value: number) => {
    setLiveDim(null);
    setDim(value);
  }, []);
  const cancelDim = useCallback(() => setLiveDim(null), []);
  const formatDim = useCallback(
    (value: number) =>
      value <= 0
        ? t('sprayWizard.look.dimOff')
        : tCommon('mobile.settings.boardLook.glowVeil.veilOpacity.value', { value: Math.round(value * 100) }),
    [t, tCommon],
  );

  const [railSlotHeight, setRailSlotHeight] = useState(0);
  const handleRailLayout = useCallback((event: LayoutChangeEvent) => {
    setRailSlotHeight(event.nativeEvent.layout.height);
  }, []);

  const previewAspect = preview ? preview.boardWidth / preview.boardHeight : null;
  const heroThumb = useMemo(() => {
    if (railSlotHeight <= 0 || previewAspect == null) return null;
    return fitSprayLookHero({
      aspect: previewAspect,
      windowWidth,
      railSlotHeight,
      captionLineHeights: captionLineHeights('hero', textStyles),
      fontScale,
    });
  }, [railSlotHeight, previewAspect, textStyles, fontScale, windowWidth]);

  const setRenderSettings = useSetSprayWallRenderSettings();
  const setRenderSettingsAsync = setRenderSettings.mutateAsync;
  const saving = setRenderSettings.isPending;
  const [saveError, setSaveError] = useState<string | null>(null);

  const handleContinue = useCallback(async () => {
    if (saving || !selectedOption) return;
    const renderSettings = boardLookOptionWallDefault(selectedOption.id, options);
    if (!renderSettings) return;
    hapticSelection();
    setSaveError(null);
    onSaveStarted();
    AccessibilityInfo.announceForAccessibility(t('sprayWizard.look.saving'));
    try {
      await setRenderSettingsAsync({ layoutId: draft.layoutId, uuid: draft.wallUuid, renderSettings });
      onConfirmed();
    } catch (error) {
      reportError(error);
      onSaveFailed();
      // Our own words, never the server's: the likeliest failure is a backend
      // that predates the field, whose message is schema jargon.
      const message = t('sprayWizard.look.failed');
      setSaveError(message);
      // `accessibilityLiveRegion` below is Android-only; VoiceOver needs telling.
      AccessibilityInfo.announceForAccessibility(message);
    }
  }, [
    saving,
    selectedOption,
    options,
    setRenderSettingsAsync,
    draft.layoutId,
    draft.wallUuid,
    onSaveStarted,
    onSaveFailed,
    onConfirmed,
    t,
  ]);

  const fallbackOptions = useMemo(
    () => options.map((option) => ({ value: option.id, label: tCommon(option.labelI18nKey) })),
    [options, tCommon],
  );
  const selectFallbackLook = useCallback(
    (id: BoardLookOptionId) => {
      if (!saving) setSelectedId(id);
    },
    [saving],
  );

  const selectedLabel = selectedOption ? tCommon(selectedOption.labelI18nKey) : '';

  return (
    <View style={[styles.root, { marginTop: headerInset }]}>
      <View style={styles.header}>
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {stepCounter}
        </Text>
        <Text variant="title3">{t('sprayWizard.look.title')}</Text>
        <Text variant="subheadline" color={systemColors.secondaryLabel}>
          {t('sprayWizard.look.body')}
        </Text>
        {notice ? (
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {notice}
          </Text>
        ) : null}
      </View>

      {/* The rail takes every point the header and footer do not, measured
          rather than computed — the header grows with the locale and the text
          size. No ScrollView around it, for the onboarding step's reason: a
          vertical scroller steals the swipes meant for the rail. */}
      <View style={styles.railSlot} onLayout={handleRailLayout}>
        {preview && railSlotHeight > 0 ? (
          <BoardLookCarousel
            options={options}
            selectedId={selectedOption?.id ?? selectedId}
            onSelect={setSelectedId}
            preview={preview}
            boardseshRendererAvailable={boardseshRendererAvailable}
            heroThumb={heroThumb}
            windowWidth={windowWidth}
            // Safe here: a snap only moves local state until Continue.
            selectOnSnap={heroThumb != null}
            showDescriptions={false}
          />
        ) : (
          <ScrollView contentContainerStyle={styles.placeholder} showsVerticalScrollIndicator>
            {draftState.isUnavailable || previewStatus === 'unavailable' ? (
              <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.centered}>
                {t('sprayWizard.look.unavailable')}
              </Text>
            ) : (
              <>
                <ActivityIndicator />
                <Text variant="subheadline" color={systemColors.secondaryLabel} accessibilityLiveRegion="polite">
                  {t('sprayWizard.look.loading')}
                </Text>
              </>
            )}
            <View
              style={styles.fallbackChoices}
              pointerEvents={saving ? 'none' : 'auto'}
              accessibilityState={{ disabled: saving }}
            >
              <RadioGroup options={fallbackOptions} value={selectedId} onChange={selectFallbackLook} />
            </View>
          </ScrollView>
        )}
      </View>

      {preview ? <RailIndexDots count={options.length} activeIndex={selectedIndex} /> : null}

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
            onLiveChange={setLiveDim}
            onCommit={commitDim}
            onCancel={cancelDim}
            testID="spray-look-dim-slider"
          />
        </View>
      ) : null}

      <View
        style={[styles.footer, { borderTopColor: systemColors.separator, paddingBottom: insets.bottom + spacing[3] }]}
      >
        {saveError ? (
          <Text
            variant="subheadline"
            color={iosSystemColors.systemRed}
            accessibilityLiveRegion="polite"
            style={styles.centered}
          >
            {saveError}
          </Text>
        ) : null}
        <Button
          title={tCommon('mobile.settings.boardLook.intro.saveNamed', { look: selectedLabel })}
          variant="filled"
          size="large"
          haptic={false}
          onPress={() => void handleContinue()}
          loading={saving}
          disabled={saving}
        />
        {saveError ? (
          <Button title={t('sprayWizard.look.publishWithout')} variant="text" onPress={onConfirmed} disabled={saving} />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  header: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[4],
    gap: spacing[1],
    // Yields to the rail on a short screen rather than squeezing it.
    flexShrink: 1,
  },
  railSlot: {
    flex: 1,
    justifyContent: 'center',
    paddingVertical: spacing[4],
  },
  fallbackChoices: {
    alignSelf: 'stretch',
  },
  placeholder: {
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[6],
  },
  dim: {
    paddingHorizontal: spacing[4],
    paddingBottom: spacing[3],
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
  footer: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[3],
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: spacing[2],
  },
});
