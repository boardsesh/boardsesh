import { Redirect } from 'expo-router';
import { loadStoryTabLayouts } from '../../../../src/dev/stories/load';
export default function Layout() {
  const layouts = loadStoryTabLayouts();
  return layouts ? <layouts.StoryTabStack /> : <Redirect href="/" />;
}
