import { Platform, View, StyleSheet } from 'react-native';
import { BoardseshLogo } from './BoardseshLogo';

// Full-screen placeholder shown while auth is still resolving — web only. On
// web there is no native splash, so a blank render leaves the page white until
// the session round-trip finishes (~2s on a cold load); this is what paints
// instead, giving an immediate first contentful paint.
//
// On iOS / Android it renders nothing. The OS splash (expo-splash-screen) owns
// that window and draws the same mark at `imageWidth: 200` — see the plugin
// config in app.config.ts — so painting a second 96pt mark underneath means any
// moment the two overlap (splash hand-off, or a later loading window such as a
// re-auth after the splash is long gone) shows the logo jumping between sizes.
export function AppLoadingSplash() {
  if (Platform.OS !== 'web') return null;

  return (
    <View style={styles.container}>
      <BoardseshLogo size={96} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    // Mirrors the expo-splash-screen backgroundColor (#000000, same for dark)
    // so web opens on the same black the native launch screen uses.
    backgroundColor: '#000000',
  },
});
