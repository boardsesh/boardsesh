import { StyleSheet, View } from 'react-native';
import { ScreenBackground } from '../../../src/components/ScreenBackground';
import { useTheme } from '../../../src/providers/theme-provider';
import { SessionScreen } from '../../../src/components/session-screen/SessionScreen';

/**
 * The real Record tab screen. Renders the session screen inline — pre-session
 * config when there's no active session, the in-session live view once one is
 * running. No overlay props: there's no drag/pull-to-dismiss here — switching
 * tabs is the minimize.
 *
 * The background is opaque systemBackground on Liquid Glass (HIG Materials: glass
 * is for the controls floating over content, not for the content itself) and the
 * flat Material surface otherwise — see ScreenBackground.
 */
export default function RecordIndex() {
  const { systemColors } = useTheme();
  return (
    <View style={styles.root}>
      <ScreenBackground color={systemColors.background} />
      <SessionScreen />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});
