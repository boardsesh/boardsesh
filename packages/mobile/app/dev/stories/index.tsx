import { Redirect } from 'expo-router';
import { loadStoryScreens } from '../../../src/dev/stories/load';

// Dev-only story index (docs/mobile-stories.md). A production bundle has no
// story screens, so the route sends anyone who lands here home.
export default function StoryIndexRoute() {
  const screens = loadStoryScreens();
  if (!screens) return <Redirect href="/" />;
  return <screens.StoryIndexScreen />;
}
