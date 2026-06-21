import { Redirect } from 'expo-router';

/**
 * App launcher route. Always lands on the Home tab, where recent beta videos
 * and followed activity sit before the deeper climb/search surfaces.
 * Explicit tab routes (join -> Record, deep links) keep their own target.
 */
export default function MobileHome() {
  return <Redirect href="/(tabs)/home" />;
}
