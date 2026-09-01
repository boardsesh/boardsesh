import { Redirect } from 'expo-router';

// Accessibility (hold colours, marker shapes, the colour-vision check) moved
// into the "Board look" screen alongside the Boardsesh render mode (issue
// #2202) — this route stays as a redirect for one release so any bookmarked
// link or stale native tab still lands somewhere real.
export default function AccessibilityRoute() {
  return <Redirect href="/(tabs)/profile/board-look" />;
}
