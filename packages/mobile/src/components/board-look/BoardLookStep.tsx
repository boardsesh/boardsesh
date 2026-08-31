import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Button } from '../Button';
import { GlassSurface } from '../GlassSurface';
import { Text } from '../Text';
import { BoardLookCarousel } from './BoardLookCarousel';
import { useTheme } from '../../providers/theme-provider';
import { selectByVariant } from '../../theme/variants';
import { useBoardRenderFlags } from '../../hooks/use-native-climb-render';
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
import { BOARD_LOOK_STEP_SEEN_KEY } from '@boardsesh/key-value-storage';
import { markTipSeen } from '../../lib/onboarding/onboarding-storage';
import { reportError } from '../../lib/error-reporting';
import { spacing } from '../../theme/tokens';

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
  /** They skipped. Nothing is written, so the app default applies. */
  onSkip: () => void;
};

/**
 * "Pick your board look" — the one-time step that asks a climber which drawing
 * they want, now that 2.4 makes the Boardsesh one the default.
 *
 * Every card is a render of THEIR board, so the choice is made on what it
 * actually looks like. Skipping is a real answer: it leaves `mode: 'default'`,
 * which is the new default, and the step never returns.
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
  onSkip,
}: BoardLookStepProps) {
  const { t } = useTranslation('common');
  const { systemColors, variant } = useTheme();
  const insets = useSafeAreaInsets();
  const { settings } = useBoardRenderSettings();
  const flags = useBoardRenderFlags();

  // Whatever they are on today leads the carousel — for this step's whole
  // audience (`mode: 'default'`) that is the plain Boardsesh card.
  const [selectedId, setSelectedId] = useState<BoardLookOptionId>(() => matchingBoardLookOptionId(settings));

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
  const flagsRef = useRef(flags);
  flagsRef.current = flags;
  const rendererAvailableRef = useRef(boardseshRendererAvailable);
  rendererAvailableRef.current = boardseshRendererAvailable;

  /** Fire the terminal event. The caller must already have claimed `resolvedRef`. */
  const report = useCallback((outcome: 'saved' | 'customized' | 'skipped', option: BoardLookOptionId | null) => {
    trackBoardLookStepResolved(
      resolveEffectiveRenderSettings(settingsRef.current, flagsRef.current, rendererAvailableRef.current === true),
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
    // Marked seen HERE, beside the Shown event, rather than when the route
    // mounts: the flag means "this climber has been asked", and the decision
    // module is explicit that a climber with nothing to preview — or on a build
    // that cannot draw the mode — must NOT have it burned. Skipping still
    // counts, and so does a force-quit mid-step, which is why it is written on
    // arrival rather than on an answer. Fire-and-forget for the same reason
    // `markOnboardingSeen` is: a keychain failure must not strand the climber,
    // but it must be reported, since swallowing it re-asks every cold start.
    markTipSeen(BOARD_LOOK_STEP_SEEN_KEY).catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.warn('[board-look] Failed to persist "seen" flag', error);
      reportError(error);
    });

    startedAtRef.current = Date.now();
    trackBoardLookStepShown(
      resolveEffectiveRenderSettings(settingsRef.current, flagsRef.current, rendererAvailableRef.current === true),
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
    // `custom` WRITES the boardsesh bundle — its card only previews `bold` under
    // a question mark — so resolving from the card's own preview settings would
    // file bold's glow/mark values under `preset_id: 'boardsesh'`.
    const appliedPreset = option === 'custom' ? 'boardsesh' : option;
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
      resolveEffectiveRenderSettings(applied, flagsRef.current, rendererAvailableRef.current === true),
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

  const handleSkip = useCallback(() => {
    resolve('skipped', null);
    onSkip();
  }, [onSkip, resolve]);

  const footerPadding = useMemo(() => Math.max(insets.bottom, spacing[4]), [insets.bottom]);

  return (
    <View style={[styles.root, { backgroundColor, paddingTop: insets.top }]} accessibilityViewIsModal>
      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <View style={styles.copy}>
          <Text variant="title1">{t('mobile.more.boardLook.intro.title')}</Text>
          <Text variant="body" color={bodyColor} style={styles.description}>
            {t('mobile.more.boardLook.intro.subtitle')}
          </Text>
        </View>

        <BoardLookCarousel
          options={BOARD_LOOK_ONBOARDING_OPTIONS}
          selectedId={selectedId}
          onSelect={setSelectedId}
          preview={preview}
          boardseshRendererAvailable={boardseshRendererAvailable}
          onCardSeen={handleCardSeen}
        />

        <View style={styles.copy}>
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.description}>
            {t('mobile.more.boardLook.intro.accessibilityNote')}
          </Text>
        </View>
      </ScrollView>

      <GlassSurface glassEffectStyle="regular" style={[styles.footer, { paddingBottom: footerPadding }]}>
        <Button
          title={
            selectedId === 'custom' ? t('mobile.more.boardLook.intro.customCta') : t('mobile.more.boardLook.intro.save')
          }
          onPress={() => void handleSave()}
          variant="filled"
          size="large"
          tintColor={selectByVariant(variant, { material: undefined, liquidGlass: accentColor })}
          haptic={false}
          style={styles.primary}
        />
        <Button
          title={t('mobile.more.boardLook.intro.skip')}
          onPress={handleSkip}
          variant="text"
          size="large"
          haptic={false}
        />
      </GlassSurface>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  body: {
    flexGrow: 1,
    justifyContent: 'center',
    gap: spacing[5],
    paddingVertical: spacing[5],
  },
  copy: {
    paddingHorizontal: spacing[5],
    gap: spacing[2],
  },
  description: {
    lineHeight: 20,
  },
  footer: {
    paddingTop: spacing[3],
    paddingHorizontal: spacing[5],
    gap: spacing[2],
  },
  primary: {
    alignSelf: 'stretch',
  },
});
