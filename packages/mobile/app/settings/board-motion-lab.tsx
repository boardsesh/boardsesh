import { useMemo } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Redirect } from 'expo-router';
import { useDeveloperSettingsAccess } from '../../src/components/settings/developer/use-developer-settings-access';
import { useTheme } from '../../src/providers/theme-provider';

// Tester-only tool (docs/board-motion-lab.md). Hiding the Developer row is not
// a guard, since a deep link reaches this route directly, so it checks the same
// access as the Developer page's dev tools. The screen module is only required
// once access is confirmed, so it stays out of the startup path.
export default function BoardMotionLabRoute() {
  // `devToolsLoading`, not `loading`: on a preview build the Developer page is
  // allowed before the profile says whether this climber is a tester, and
  // `loading` would already be false and send a tester away.
  const { showDevTools, devToolsLoading } = useDeveloperSettingsAccess();
  const { systemColors } = useTheme();

  const lab = useMemo(
    () =>
      showDevTools
        ? (require('../../src/components/board-motion-lab/screen') as typeof import('../../src/components/board-motion-lab/screen'))
        : null,
    [showDevTools],
  );

  if (lab) return <lab.default />;
  if (devToolsLoading) {
    return (
      <View style={[styles.loading, { backgroundColor: systemColors.groupedBackground }]}>
        <ActivityIndicator />
      </View>
    );
  }
  return <Redirect href="/settings" />;
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
