import { Platform, StyleSheet, View } from 'react-native';
import { GlassSurface } from '../../../src/components/GlassSurface';
import { SessionScreen } from '../../../src/components/session-screen/SessionScreen';
import { useHasBeenFocused } from '../../../src/hooks/use-has-been-focused';

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
 *
 * SessionScreen mounts on the tab's first focus, not at launch. NativeTabs renders
 * every tab up front, and the pre-session view runs the workout generator, the
 * grade-pool fetch and a board-photo decode as soon as it mounts. The JS Tabs
 * navigator mounted Record lazily, so this keeps that cost off a cold start.
 * Android keeps its eager mount: the tab layout sets `lazy: false` there on
 * purpose, because a lazy first mount of this stack could leave Record blank.
 */
export default function RecordIndex() {
  const hasBeenFocused = useHasBeenFocused();
  const mountSession = hasBeenFocused || Platform.OS === 'android';
  return (
    <View style={styles.root}>
      <GlassSurface glassEffectStyle="regular" style={StyleSheet.absoluteFill} level="level0" pointerEvents="none" />
      {mountSession ? <SessionScreen /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});
