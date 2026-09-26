import { Redirect } from 'expo-router';

// Accessibility (hold colours, marker shapes, the colour-vision check) moved
// into the "Board look" screen alongside the Boardsesh render mode (issue
// #2202) — this route stays as a redirect so any bookmarked link or stale
// native tab still lands somewhere real.
//
// It keeps its ORIGINAL `/profile/accessibility` URL even though Board look now
// lives under `/settings`: this route exists only to answer links minted before
// the screen moved, and those links say `/profile`. Same reason `more.tsx` sits
// beside it.
export default function AccessibilityRoute() {
  return <Redirect href="/settings/board-look" />;
}
