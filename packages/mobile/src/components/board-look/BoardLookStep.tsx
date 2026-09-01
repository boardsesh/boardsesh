import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Button } from '../Button';
import { GlassSurface } from '../GlassSurface';
import { Text } from '../Text';
import { BoardLookCarousel } from './BoardLookCarousel';
import { RailIndexDots } from './RailIndexDots';
import { useTheme } from '../../providers/theme-provider';
import { selectByVariant } from '../../theme/variants';
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
  /** Primary CTA accent (HIG: systemColors.accent; Material: colors.primary). */
  accentColor: string;
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
 * Every card is a render of THEIR board, so the choice is made on what it
 * actually looks like. That is also why the rail is the hero here rather than a
 * thumbnail strip: the difference between these looks is glow radius and stroke
 * weight over a dozen holds, which is invisible at thumbnail size. The rail gets
 * every point of height the copy and the button do not need, and the cards take
 * the board's own shape so none of it is spent on letterbox bars.
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
  accentColor,
  bodyColor,
  backgroundColor,
  preview,
  boardseshRendererAvailable,
  onSaved,
  onCustomize,
}: BoardLookStepProps) {
  const { t } = useTranslation('common');
  const { systemColors, variant, textStyles } = useTheme();
  const insets = useSafeAreaInsets();
  const { width: windowWidth, fontScale } = useWindowDimensions();
  const { settings } = useBoardRenderSettings();

  useBlockBack();

  // Whatever they are on today leads the carousel — for this step's whole
  // audience (`mode: 'default'`) that is the plain Boardsesh card.
  const [selectedId, setSelectedId] = useState<BoardLookOptionId>(() => matchingBoardLookOptionId(settings));

  // MEASURED, never computed from the window: the header above the rail grows
  // with the locale and the text size (the German subtitle is 97 characters
  // against 84 in en-US), so any arithmetic guess at its height is wrong in some
  // language at some text size.
  const [railSlotHeight, setRailSlotHeight] = useState(0);
  const handleRailLayout = useCallback((event: LayoutChangeEvent) => {
    setRailSlotHeight(event.nativeEvent.layout.height);
  }, []);

  const heroThumb = useMemo(() => {
    if (railSlotHeight <= 0) return null;
    const caption = captionBlockHeight(captionLineHeights('hero', textStyles), fontScale);
    return resolveHeroThumb({
      aspect: preview.boardWidth / preview.boardHeight,
      windowWidth,
      heightBudget: railSlotHeight - caption,
    });
  }, [railSlotHeight, textStyles, fontScale, preview.boardWidth, preview.boardHeight, windowWidth]);

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

  const footerPadding = useMemo(() => Math.max(insets.bottom, spacing[4]), [insets.bottom]);

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
      ? t('mobile.more.boardLook.intro.customCta')
      : t('mobile.more.boardLook.intro.saveNamed', { look: selectedLabel });

  return (
    <View style={[styles.root, { backgroundColor, paddingTop: insets.top }]} accessibilityViewIsModal>
      <View style={styles.header}>
        <Text variant="title1">{t('mobile.more.boardLook.intro.title')}</Text>
        <Text variant="subheadline" color={bodyColor} style={styles.description}>
          {t('mobile.more.boardLook.intro.subtitle')}
        </Text>
      </View>

      {/* The rail takes every point the header and footer do not, and reports
          back how many it got. No ScrollView: a vertical scroller wrapping a
          near-full-height horizontal rail steals the swipes meant for the rail,
          and on a one-time forced choice it could scroll the button away from
          the thing the button commits to. */}
      <View style={styles.railSlot} onLayout={handleRailLayout}>
        {railSlotHeight > 0 ? (
          <BoardLookCarousel
            options={BOARD_LOOK_ONBOARDING_OPTIONS}
            selectedId={selectedId}
            onSelect={setSelectedId}
            preview={preview}
            boardseshRendererAvailable={boardseshRendererAvailable}
            onCardSeen={handleCardSeen}
            heroThumb={heroThumb}
            windowWidth={windowWidth}
            // Safe here and nowhere else: this only moves local state until the
            // footer button is pressed. In settings the same callback writes
            // through to the physical board's LEDs.
            selectOnSnap={heroThumb != null}
          />
        ) : null}
      </View>

      {/* Hero scale shows ~1.2 cards where the old rail showed ~2.2, so the dots
          carry what the composition used to: how many looks there are. */}
      <RailIndexDots count={BOARD_LOOK_ONBOARDING_OPTIONS.length} activeIndex={selectedIndex} />

      <GlassSurface glassEffectStyle="regular" style={[styles.footer, { paddingBottom: footerPadding }]}>
        {/* Fine print about what the button will and will not do, so it sits with
            the button rather than floating as a third block of copy. */}
        <Text variant="caption1" color={systemColors.secondaryLabel} style={styles.footnote}>
          {t('mobile.more.boardLook.intro.accessibilityNote')}
        </Text>
        <Button
          title={ctaLabel}
          onPress={() => void handleSave()}
          variant="filled"
          size="large"
          tintColor={selectByVariant(variant, { material: undefined, liquidGlass: accentColor })}
          haptic={false}
          style={styles.primary}
        />
      </GlassSurface>
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
    flexShrink: 1,
  },
  description: {
    lineHeight: 20,
  },
  railSlot: {
    flex: 1,
    justifyContent: 'center',
    paddingVertical: spacing[4],
  },
  footer: {
    paddingTop: spacing[3],
    paddingHorizontal: spacing[5],
    gap: spacing[3],
  },
  footnote: {
    textAlign: 'center',
    lineHeight: 16,
  },
  primary: {
    alignSelf: 'stretch',
  },
});
