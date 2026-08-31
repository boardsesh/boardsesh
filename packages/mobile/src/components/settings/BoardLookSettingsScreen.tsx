import { useCallback } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { useTheme } from '../../providers/theme-provider';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { useEffectiveBoardRenderSettings } from '../../hooks/use-native-climb-render';
import { useBoardRenderSettings } from '../../lib/board-render-settings';
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
 * Glow & veil and Marks are always shown, even in Classic — a climber can tune
 * every Boardsesh knob before flipping the mode switch. The marker
 * shape/brush/size rows (inside AccessibilitySection) stay mode-gated, because
 * they describe a drawing that isn't the one currently on screen.
 */
export function BoardLookSettingsScreen() {
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();
  const { scrollBottomPadding } = useBottomChromeMetrics();
  const { settings, setMode, setBoardseshField, reset: resetRenderSettings } = useBoardRenderSettings();
  const { effectiveRenderSettings, boardseshRendererAvailable } = useEffectiveBoardRenderSettings();
  const { resetOverrides } = useHoldColorOverrides();

  const handleResetAll = useCallback(() => {
    resetRenderSettings();
    resetOverrides();
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
      />

      <GlowVeilSection
        boardsesh={settings.boardsesh}
        effectiveGlowFalloff={effectiveRenderSettings.glowFalloff}
        setBoardseshField={setBoardseshField}
      />

      <MarksSection boardsesh={settings.boardsesh} setBoardseshField={setBoardseshField} />

      <AccessibilitySection
        effectiveMode={effectiveRenderSettings.mode}
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
