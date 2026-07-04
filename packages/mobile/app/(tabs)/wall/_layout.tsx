import { Stack } from 'expo-router';
import { useStackScreenOptions } from '../../../src/hooks/use-stack-screen-options';

/**
 * The "On the Wall" tab. iPad-only — it's registered as an `href: null` tab screen
 * (hidden from every phone tab bar) and reached from the iPad sidebar rail; see
 * `app/(tabs)/_layout.tsx`. A single inline `index` for now; the Stack gives future
 * deep links / sub-routes (a full leaderboard, a per-climb wall detail) a home.
 */
export default function WallLayout() {
  const screenOptions = useStackScreenOptions();

  return (
    <Stack screenOptions={screenOptions}>
      <Stack.Screen name="index" options={{ headerShown: false }} />
    </Stack>
  );
}
