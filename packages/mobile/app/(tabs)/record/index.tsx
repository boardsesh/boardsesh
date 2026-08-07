import { StyleSheet, View } from 'react-native';
import { GlassSurface } from '../../../src/components/GlassSurface';
import { SessionScreen } from '../../../src/components/session-screen/SessionScreen';

/**
 * The real Record tab screen. Renders the session screen inline — pre-session
 * config when there's no active session, the in-session live view once one is
 * running. A GlassSurface fills the background so the Liquid-Glass language from
 * the rest of the chrome carries through. No overlay props: there's no
 * drag/pull-to-dismiss here — switching tabs is the minimize.
 *
 * The fill is flat (`level0`) and non-interactive: it's a background with
 * SessionScreen stacked on top as a sibling, and Android orders siblings by Z, so
 * the Material branch's default `shadows.sm` cast (elevation 2) would lift it over
 * the session content (the shape that broke the play drawer in #4209).
 */
export default function RecordIndex() {
  return (
    <View style={styles.root}>
      <GlassSurface glassEffectStyle="regular" style={StyleSheet.absoluteFill} level="level0" pointerEvents="none" />
      <SessionScreen />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});
