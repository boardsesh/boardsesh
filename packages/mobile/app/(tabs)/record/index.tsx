import { Platform, StyleSheet, View } from 'react-native';
import { ScreenBackground } from '../../../src/components/ScreenBackground';
import { useTheme } from '../../../src/providers/theme-provider';
import { SessionScreen } from '../../../src/components/session-screen/SessionScreen';
import { useHasBeenFocused } from '../../../src/hooks/use-has-been-focused';

/**
 * The real Record tab screen. Renders the session screen inline — pre-session
 * config when there's no active session, the in-session live view once one is
 * running. No overlay props: there's no drag/pull-to-dismiss here — switching
 * tabs is the minimize.
 *
 * The background is opaque systemBackground (HIG Materials: glass belongs to
 * controls). SessionScreen mounts on first focus to keep the workout generator,
 * grade-pool fetch and board-photo decode off a cold start. Android keeps its
 * eager mount because lazily mounting this stack could leave Record blank.
 */
export default function RecordIndex() {
  const { systemColors } = useTheme();
  const hasBeenFocused = useHasBeenFocused();
  const mountSession = hasBeenFocused || Platform.OS === 'android';
  return (
    <View style={styles.root}>
      <ScreenBackground color={systemColors.background} />
      {mountSession ? <SessionScreen /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});
