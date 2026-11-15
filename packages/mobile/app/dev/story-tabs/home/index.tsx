import { Redirect } from 'expo-router';
import { loadStoryScreens } from '../../../../src/dev/stories/load';
export default function Screen() {
  const screens = loadStoryScreens();
  return screens ? <screens.StoryScreen inTab tab="home" defaultStoryId="home--feed" /> : <Redirect href="/" />;
}
