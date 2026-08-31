import { ScrollView, StyleSheet } from 'react-native';
import { useBottomChromeMetrics } from '../../../hooks/use-bottom-chrome-metrics';
import { useBoardLookSettings } from '../../../lib/board-render/use-board-look-settings';
import { spacing } from '../../../theme/tokens';
import { AccessibilitySection } from '../sections/AccessibilitySection';

/**
 * "Accessibility", the second Board look leaf: hold colours, marker shapes, role
 * glyphs, the colour-vision palettes and the colour-blind check.
 *
 * These controls used to sit below the render knobs on one long screen, at the
 * same visual level, so the screen read as a tuning panel rather than a picker.
 * They are the same controls — the split is about where they live, not what they
 * do — so the section is wrapped rather than rewritten.
 *
 * It keeps its own "Reset hold markers". The parent's "Reset board look" used to
 * clear these too, under a label that never mentioned them: colours and shapes
 * the climber set here, which also drive the physical board's LEDs. Each reset
 * now clears only what its own screen shows.
 *
 * `setBoardseshField` comes from `useBoardLookSettings`, which is the app's one
 * mirroring writer. Role glyphs used to be wired to the raw setter, so toggling
 * it never reached the remembered custom look.
 */
export function BoardLookAccessibilityScreen() {
  const { scrollBottomPadding } = useBottomChromeMetrics();
  const { settings, requestedMode, boardseshRendererAvailable, setBoardseshField } = useBoardLookSettings();

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={[styles.content, { paddingBottom: scrollBottomPadding + spacing[4] }]}
    >
      <AccessibilitySection
        requestedMode={requestedMode}
        boardseshRendererAvailable={boardseshRendererAvailable}
        boardsesh={settings.boardsesh}
        setBoardseshField={setBoardseshField}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    flexGrow: 1,
    paddingTop: spacing[4],
    gap: spacing[6],
  },
});
