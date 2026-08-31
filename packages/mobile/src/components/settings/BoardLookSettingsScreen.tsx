import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { useEffectiveBoardRenderSettings } from '../../hooks/use-native-climb-render';
import { requestedBoardRenderMode, useBoardRenderSettings } from '../../lib/board-render-settings';
import { matchingBoardLookOptionId } from '../../lib/board-render/board-look-options';
import {
  clearCustomBoardLook,
  loadCustomBoardLook,
  rememberCustomBoardLook,
} from '../../lib/board-render/custom-board-look';
import { setBoardRenderSettingsPreference } from '../../lib/board-render-settings';
import { useHoldColorOverrides } from '../../lib/hold-color-overrides';
import { spacing } from '../../theme/tokens';
import { ModeAndPresetsSection } from './sections/ModeAndPresetsSection';
import { GlowVeilSection } from './sections/GlowVeilSection';
import { MarksSection } from './sections/MarksSection';
import { AccessibilitySection } from './sections/AccessibilitySection';

/**
 * "Board look" (issue #2202): the settings screen for the render mode
 * (Automatic / Classic / Boardsesh) and every knob the Boardsesh drawing
 * exposes, plus the accessibility controls (hold colours, marker shapes, the
 * colour-vision check) that used to live on their own Accessibility screen —
 * see `AccessibilitySection` and `app/(tabs)/profile/accessibility.tsx`
 * (now a one-release `Redirect` here).
 *
 * The look carousel leads: picking a board from a row of real renders is how
 * almost everyone will choose, so it comes before the Render control, which
 * exists mainly to express `Automatic` and is the more technical way to say the
 * same thing. It is no longer mode-gated either — Classic is one of its cards,
 * and a climber sitting on Classic is exactly who benefits from seeing the
 * alternatives drawn on their own board.
 *
 * Glow & veil and Marks belong to Custom, and only appear once it is selected.
 * Presets are how almost everyone picks a look; showing eleven knobs above the
 * accessibility controls made the screen read as a tuning panel with presets
 * bolted on, rather than a picker you can open up if you want to.
 *
 * Selecting Custom writes nothing. It cannot: the climber's settings already
 * equal whichever preset they are on, so applying anything would overwrite the
 * tuning the card exists to expose. `customOpen` is therefore local UI state —
 * "show me the knobs" — and the moment a knob moves the settings genuinely stop
 * matching a preset, so `matchingBoardLookOptionId` reports `custom` on its own
 * and the two agree without being wired together.
 *
 * The marker shape/brush/size rows (inside AccessibilitySection) stay gated on
 * the drawing being Classic, because they describe a drawing that isn't the one
 * currently on screen.
 */
export function BoardLookSettingsScreen() {
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();
  const { scrollBottomPadding } = useBottomChromeMetrics();
  const { settings, setMode, setBoardseshField, reset: resetRenderSettings } = useBoardRenderSettings();
  const { effectiveRenderSettings, boardseshRendererAvailable } = useEffectiveBoardRenderSettings();
  const { resetOverrides } = useHoldColorOverrides();
  const [customOpen, setCustomOpen] = useState(false);

  // Already off a preset? Then the knobs are what they are looking at, so open.
  const matchingOption = matchingBoardLookOptionId(settings);
  const showCustomControls = customOpen || matchingOption === 'custom';

  // Every knob change is the climber's custom look, remembered so that trying a
  // preset is reversible. Without this, tuning a look, tapping "Subtle" to
  // compare, and coming back to Custom loses the tuning for good.
  const handleSetBoardseshField = useCallback<typeof setBoardseshField>(
    (field, value) => {
      setBoardseshField(field, value);
      void rememberCustomBoardLook({ ...settings.boardsesh, [field]: value });
    },
    [setBoardseshField, settings.boardsesh],
  );

  // Bring back what they had, if they have tuned anything. Nothing remembered
  // yet just means the knobs open on whatever preset they were already on,
  // which is the sensible place to start from.
  const handleCustomSelected = useCallback(() => {
    setCustomOpen(true);
    void loadCustomBoardLook().then((custom) => {
      if (custom) void setBoardRenderSettingsPreference({ mode: 'boardsesh', boardsesh: custom });
    });
  }, []);

  const handleResetAll = useCallback(() => {
    resetRenderSettings();
    resetOverrides();
    void clearCustomBoardLook();
    setCustomOpen(false);
  }, [resetOverrides, resetRenderSettings]);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={[styles.scrollContent, { paddingBottom: scrollBottomPadding + spacing[4] }]}
    >
      <View style={styles.intro}>
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.description}>
          {t('mobile.more.boardLook.description')}
        </Text>
      </View>

      <ModeAndPresetsSection
        settings={settings}
        setMode={setMode}
        effectiveMode={effectiveRenderSettings.mode}
        boardseshRendererAvailable={boardseshRendererAvailable}
        selectedOptionId={showCustomControls ? 'custom' : matchingOption}
        onCustomSelected={handleCustomSelected}
        onPresetSelected={() => setCustomOpen(false)}
        showModeControl={showCustomControls}
      />

      {showCustomControls ? (
        <>
          <GlowVeilSection
            boardsesh={settings.boardsesh}
            effectiveGlowFalloff={effectiveRenderSettings.glowFalloff}
            setBoardseshField={handleSetBoardseshField}
          />

          <MarksSection boardsesh={settings.boardsesh} setBoardseshField={handleSetBoardseshField} />
        </>
      ) : null}

      <AccessibilitySection
        requestedMode={requestedBoardRenderMode(settings)}
        boardseshRendererAvailable={boardseshRendererAvailable}
        boardsesh={settings.boardsesh}
        setBoardseshField={setBoardseshField}
      />

      <Pressable accessibilityRole="button" onPress={handleResetAll} style={styles.resetButton}>
        <Text variant="footnote" color={systemColors.accent}>
          {t('mobile.more.boardLook.resetAll')}
        </Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollContent: {
    flexGrow: 1,
    paddingTop: spacing[4],
    gap: spacing[6],
  },
  intro: {
    paddingHorizontal: spacing[4],
  },
  description: {
    lineHeight: 18,
  },
  resetButton: {
    alignSelf: 'flex-start',
    paddingVertical: spacing[1],
    paddingHorizontal: spacing[4],
  },
});
