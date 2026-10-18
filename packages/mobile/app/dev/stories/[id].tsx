import { Redirect } from 'expo-router';
import { loadStoryScreens } from '../../../src/dev/stories/load';

// Dev-only: `dev/stories/<id>` draws one story or opens a scenario
// (docs/mobile-stories.md). A production bundle has no story screens.
export default function StoryRoute() {
  const screens = loadStoryScreens();
  if (!screens) return <Redirect href="/" />;
  return <screens.StoryScreen />;
}
