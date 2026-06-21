import { StyleSheet, View } from 'react-native';
import { GlassSurface } from '../../../src/components/GlassSurface';
import { SessionScreen } from '../../../src/components/session-screen/SessionScreen';

/**
 * The real Record tab screen. Renders the session screen inline — pre-session
 * config when there's no active session, the in-session live view once one is
 * running. A GlassSurface fills the background so the Liquid-Glass language from
 * the rest of the chrome carries through. No overlay props: there's no
 * drag/pull-to-dismiss here — switching tabs is the minimize.
 */
export default function RecordIndex() {
  return (
    <View style={styles.root}>
      <GlassSurface glassEffectStyle="regular" style={StyleSheet.absoluteFill} />
      <SessionScreen />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});
