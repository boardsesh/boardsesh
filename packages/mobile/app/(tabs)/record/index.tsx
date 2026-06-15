import { StyleSheet, View } from 'react-native';
import { SessionScreen } from '../../../src/components/session-screen/SessionScreen';

/**
 * The real Record tab screen. Renders the session screen inline — pre-session
 * config when there's no active session, the in-session live view once one is
 * running. The screen sits on the navigation scene background (like the
 * Discover/Climbs/Profile tabs); the floating chrome carries the Liquid-Glass
 * language. A full-bleed glass base here only dimmed the scene to grey, which
 * clashed with the header scrim's white fade in light mode. No overlay props:
 * there's no drag/pull-to-dismiss here — switching tabs is the minimize.
 */
export default function RecordIndex() {
  return (
    <View style={styles.root}>
      <SessionScreen />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});
