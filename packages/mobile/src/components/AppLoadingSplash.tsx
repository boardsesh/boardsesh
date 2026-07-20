import { View, StyleSheet } from 'react-native';
import { BoardseshLogo } from './BoardseshLogo';

// Full-screen placeholder shown while auth is still resolving. On native the OS
// splash screen covers this until `SplashScreen.hideAsync()` runs (auth + fonts
// ready), so it's never actually visible there. On web there is no native
// splash, so a blank render leaves the page white until the session round-trip
// finishes (~2s on a cold load) — this is what paints instead, giving an
// immediate first contentful paint. Matches the expo-splash-screen config: the
// Boardsesh mark centered on black, in both light and dark.
export function AppLoadingSplash() {
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
    // so the hand-off from the native splash to this placeholder is seamless.
    backgroundColor: '#000000',
  },
});
