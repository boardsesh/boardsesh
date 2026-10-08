import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { SheetTopBar } from '../SheetTopBar';
import { Text } from '../Text';
import { BoardLookSlider } from './BoardLookSlider';
import { useTheme } from '../../providers/theme-provider';
import { useBoardRenderSettings, resolveEffectiveRenderSettings } from '../../lib/board-render-settings';
import {
  BOARD_LOOK_ONBOARDING_OPTIONS,
  applyBoardLookOption,
  matchingBoardLookOptionId,
  type BoardLookOptionId,
} from '../../lib/board-render/board-look-options';
import { mergePresetPreservingAccessibility } from '../../lib/board-render-presets';
import {
  trackBoardLookApplied,
  trackBoardLookStepShown,
  trackBoardLookStepResolved,
} from '../../lib/board-render/board-look-analytics';
import type { BoardPreviewSource } from '../../hooks/use-board-preview-climb';
import { markBoardLookStepSeen } from '../../lib/board-render/board-look-step-seen';
import { reportError } from '../../lib/error-reporting';
import { useBlockBack } from '../onboarding/use-block-back';
import { spacing } from '../../theme/tokens';
import { captionBlockHeight, captionLineHeights, resolveHeroThumb } from './board-look-card-metrics';

type BoardLookStepProps = {
  /** Body/subtext colour. */
  bodyColor: string;
  /** Opaque background under the reading text. */
  backgroundColor: string;
  /** The climber's own board and a real climb on it, to draw every card with. */
  preview: BoardPreviewSource;
  /** `null` = the capability probe has not answered; cards skeleton rather than lie. */
  boardseshRendererAvailable: boolean | null;
  /** They picked a look. Settings are already written. */
  onSaved: () => void;
  /** They picked Custom. The Boardsesh bundle is written; open Board look next. */
  onCustomize: () => void;
};

/**
 * "Pick your board look" — the one-time step that asks a climber which drawing
 * they want, now that 2.4 makes the Boardsesh one the default.
 *
 * One preview draws the climber's own board and climb. The horizontal slider
 * changes the preview locally; only the primary action saves the chosen look.
 * The content can scroll vertically at larger text sizes while Save stays
 * available in the top bar.
 *
 * **There is no exit** (issue #4961): the "Not now" secondary is gone, because
 * declining silently accepted the new default — the one outcome this step exists
 * to stop being silent. Android hardware back is swallowed too. The funnel still
 * has a `skipped` outcome, fired by the unmount guard, for the nav-away that no
 * button produced.
 *
 * The one-shot "seen" flag is written on an ANSWER, never on arrival, so the
 * same silence cannot come back through the storage layer: leaving without
 * answering (a force-quit, a programmatic nav-away) leaves both the flag and
 * `mode: 'default'` untouched and the gate asks again next launch.
 *
 * Safe to make mandatory only because `decideBoardLookStep` refuses to present it
 * unless there is a synced climb to draw AND the renderer probe has answered
 * `true`. If that gate is ever relaxed, the exit has to come back.
 *
 * Variant-agnostic like `OnboardingPrompt` — the route resolves the palette from
 * the active UI variant and injects it, so one component serves both skins.
 */
export function BoardLookStep({
  bodyColor,
  backgroundColor,
  preview,
  boardseshRendererAvailable,
  onSaved,
  onCustomize,
}: BoardLookStepProps) {
  const { t } = useTranslation('common');
  const { systemColors, textStyles } = useTheme();
  const insets = useSafeAreaInsets();
  const { width: windowWidth, fontScale } = useWindowDimensions();
  const { settings } = useBoardRenderSettings();

  useBlockBack();

  // Start on their current offered look, or Aura for a settings-only preset.
  const [selectedId, setSelectedId] = useState<BoardLookOptionId>(() => {
    const currentId = matchingBoardLookOptionId(settings);
    return BOARD_LOOK_ONBOARDING_OPTIONS.some((option) => option.id === currentId)
      ? currentId
      : BOARD_LOOK_ONBOARDING_OPTIONS[0].id;
  });
  const [saving, setSaving] = useState(false);

  // MEASURED, never computed from the window: the header above the rail grows
  // with the locale and the text size (the German subtitle is 97 characters
  // against 84 in en-US), so any arithmetic guess at its height is wrong in some
  // language at some text size.
  const [previewSlotHeight, setRailSlotHeight] = useState(0);
  const handlePreviewLayout = useCallback((event: LayoutChangeEvent) => {
    setRailSlotHeight(event.nativeEvent.layout.height);
  }, []);

  const heroThumb = useMemo(() => {
    if (previewSlotHeight <= 0) return null;
    // No description under a hero card, so nothing to reserve for one.
    const caption = captionBlockHeight(captionLineHeights('hero', textStyles), fontScale, 0);
    return resolveHeroThumb({
      aspect: preview.boardWidth / preview.boardHeight,
      windowWidth,
      heightBudget: previewSlotHeight - caption - 60,
    });
  }, [previewSlotHeight, textStyles, fontScale, preview.boardWidth, preview.boardHeight, windowWidth]);

  const startedAtRef = useRef(Date.now());
  // Every Shown must resolve to exactly one terminal event. If they leave via
  // Android back or a nav-away without choosing, the unmount cleanup fires
  // `skipped` so the funnel never reads a backed-out climber as one who never
  // arrived.
  const resolvedRef = useRef(false);
  const cardsSeenRef = useRef(new Set<BoardLookOptionId>());
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  const analyticsContext = useMemo(
    () => ({ boardName: preview.boardName, layoutId: preview.layoutId, sizeId: preview.sizeId }),
    [preview.boardName, preview.layoutId, preview.sizeId],
  );
  // Refs so the resolve helper below is stable and the unmount cleanup reads the
  // CURRENT values rather than the ones captured when the step mounted.
  const analyticsContextRef = useRef(analyticsContext);
  analyticsContextRef.current = analyticsContext;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const rendererAvailableRef = useRef(boardseshRendererAvailable);
  rendererAvailableRef.current = boardseshRendererAvailable;

  /** Fire the terminal event. The caller must already have claimed `resolvedRef`. */
  const report = useCallback((outcome: 'saved' | 'customized' | 'skipped', option: BoardLookOptionId | null) => {
    trackBoardLookStepResolved(
      resolveEffectiveRenderSettings(settingsRef.current, rendererAvailableRef.current === true),
      analyticsContextRef.current,
      {
        outcome,
        selectedOption: option,
        cardsViewed: cardsSeenRef.current.size,
        msToResolve: Math.max(0, Date.now() - startedAtRef.current),
      },
    );
  }, []);

  /** Resolve, unless something already has. */
  const resolve = useCallback(
    (outcome: 'saved' | 'customized' | 'skipped', option: BoardLookOptionId | null) => {
      if (resolvedRef.current) return;
      resolvedRef.current = true;
      report(outcome, option);
    },
    [report],
  );

  useEffect(() => {
    startedAtRef.current = Date.now();
    trackBoardLookStepShown(
      resolveEffectiveRenderSettings(settingsRef.current, rendererAvailableRef.current === true),
      analyticsContextRef.current,
      BOARD_LOOK_ONBOARDING_OPTIONS.length,
    );
    return () => {
      resolve('skipped', null);
    };
  }, [resolve]);

  const handleCardSeen = useCallback((id: BoardLookOptionId) => {
    cardsSeenRef.current.add(id);
  }, []);

  const handleSave = useCallback(async () => {
    if (resolvedRef.current) return;
    // Claimed synchronously, BEFORE the await: an Android back press during the
    // write would otherwise let the unmount cleanup fire `skipped` first, and a
    // save would land in the funnel as an abandon.
    resolvedRef.current = true;
    setSaving(true);

    // Marked seen HERE, on an answer, and nowhere else. Writing it on arrival
    // burned the one-shot question for a climber who never got to answer it: a
    // force-quit or a programmatic nav-away mid-step left `mode: 'default'`
    // stored and the flag set, so the gate never asked again and the new
    // default was accepted in silence — the one outcome a mandatory step exists
    // to prevent. Unasked is now indistinguishable from unanswered, and both
    // re-ask.
    //
    // Written before the await and regardless of whether the settings write
    // below succeeds: the same trade `markOnboardingSeen` makes, where a
    // storage failure must not strand a climber on a screen with no exit.
    // Fire-and-forget, but reported — swallowing it re-asks every cold start.
    markBoardLookStepSeen().catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.warn('[board-look] Failed to persist "seen" flag', error);
      reportError(error);
    });

    const option = selectedIdRef.current;
    try {
      await applyBoardLookOption(option);
    } catch (error: unknown) {
      // The same trade `markOnboardingSeen` makes in app/onboarding.tsx: a
      // storage failure must not strand the climber on a one-shot step, but it
      // must be reported, because swallowing it silently loses their choice.
      // eslint-disable-next-line no-console
      console.warn('[board-look] Failed to persist the chosen look', error);
      reportError(error);
    }

    // Report the settings the choice PRODUCES, not the ones it replaced — the
    // shared contract reads a preset-applied event as "the common props now
    // carry this preset_id".
    // `custom` WRITES the plain Aura bundle — its card only previews Aura Bold
    // under a question mark — so resolving from the card's own preview settings
    // would file Aura Bold's glow/mark values under `preset_id: 'aura'`.
    // Typed as the option union rather than inferred: a bare string literal
    // still overlaps it, so a stale id would type-check and then silently miss
    // the `.find` below, reporting the climber's OLD settings as applied.
    const appliedPreset: BoardLookOptionId = option === 'custom' ? 'aura' : option;
    const applied =
      option === 'classic'
        ? { ...settingsRef.current, mode: 'classic' as const }
        : mergePresetPreservingAccessibility(
            BOARD_LOOK_ONBOARDING_OPTIONS.find((entry) => entry.id === appliedPreset)?.previewSettings ??
              settingsRef.current,
            settingsRef.current,
          );
    trackBoardLookApplied(
      option,
      resolveEffectiveRenderSettings(applied, rendererAvailableRef.current === true),
      analyticsContextRef.current,
      'onboarding',
    );

    if (option === 'custom') {
      report('customized', option);
      onCustomize();
      return;
    }
    report('saved', option);
    onSaved();
  }, [onCustomize, onSaved, report]);

  // Clamped, not defaulted: `matchingBoardLookOptionId` can name a look this
  // step does not offer (`bold` is settings-only), and a -1 would otherwise index
  // past the end. Falling back to the leading card keeps a real option — and a
  // real i18n key — in hand.
  const selectedIndex = Math.max(
    0,
    BOARD_LOOK_ONBOARDING_OPTIONS.findIndex((option) => option.id === selectedId),
  );
  const selectedOption = BOARD_LOOK_ONBOARDING_OPTIONS[selectedIndex] ?? BOARD_LOOK_ONBOARDING_OPTIONS[0];
  const selectedLabel = t(selectedOption.labelI18nKey);

  // Names the look rather than saying "this". Once the chosen card is centred
  // under the reader's eye the pronoun has an antecedent on screen, but a climber
  // reading only the button — or hearing it read out — still needs telling which
  // look they are about to commit to.
  const ctaLabel =
    selectedId === 'custom'
      ? t('mobile.settings.boardLook.intro.customCta')
      : t('mobile.settings.boardLook.intro.saveNamed', { look: selectedLabel });

  return (
    <View
      style={[
        styles.root,
        { backgroundColor, paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, spacing[4]) },
      ]}
      accessibilityViewIsModal
    >
      {/* The route hides the native header (a transparentModal), so the step
          draws its own top bar. No leading action: this step has no exit. */}
      <SheetTopBar
        title=""
        trailing={{
          kind: 'forward',
          label: ctaLabel,
          onPress: () => void handleSave(),
          prominent: true,
          disabled: saving,
          loading: saving,
        }}
      />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text variant="title1">{t('mobile.settings.boardLook.intro.title')}</Text>
          <Text variant="subheadline" color={bodyColor} style={styles.description}>
            {t('mobile.settings.boardLook.intro.subtitle')}
          </Text>
        </View>

        {/* A vertical scroll fallback keeps the preview and controls reachable at
          accessibility text sizes; slider gestures only claim horizontal intent. */}
        <View style={styles.previewSlot} onLayout={handlePreviewLayout}>
          {previewSlotHeight > 0 ? (
            <BoardLookSlider
              options={BOARD_LOOK_ONBOARDING_OPTIONS}
              selectedId={selectedId}
              onSelect={setSelectedId}
              preview={preview}
              boardseshRendererAvailable={boardseshRendererAvailable}
              onCardSeen={handleCardSeen}
              heroThumb={heroThumb}
              showDescription={false}
              disabled={saving}
              testID="onboarding-board-look-slider"
            />
          ) : null}
        </View>

        {/* Fine print about what the save will and will not do. The second line
          is the exit this step does not otherwise have: it is mandatory and has
          no "Not now", so saying the choice is reversible is what makes
          committing to one cheap. */}
        <View style={styles.footnotes}>
          <Text variant="caption1" color={systemColors.secondaryLabel} style={styles.footnote}>
            {t('mobile.settings.boardLook.intro.accessibilityNote')}
          </Text>
          <Text variant="caption1" color={systemColors.secondaryLabel} style={styles.footnote}>
            {t('mobile.settings.boardLook.intro.changeLaterNote')}
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  header: {
    paddingHorizontal: spacing[5],
    paddingTop: spacing[2],
    gap: spacing[1],
    // Yields to the rail on a short screen rather than squeezing it.
    flexShrink: 0,
  },
  content: { flexGrow: 1 },
  description: {
    lineHeight: 20,
  },
  previewSlot: {
    flex: 1,
    justifyContent: 'center',
    paddingVertical: spacing[4],
  },
  footnotes: {
    paddingTop: spacing[3],
    paddingHorizontal: spacing[5],
    gap: spacing[1],
  },
  footnote: {
    textAlign: 'center',
    lineHeight: 16,
  },
});
