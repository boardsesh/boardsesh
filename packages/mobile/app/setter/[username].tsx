import { Redirect, useLocalSearchParams } from 'expo-router';

/**
 * Where a shared setter link lands. The link is www's URL, and iOS hands it to
 * the app without loading the page, so without this route `+not-found` sends the
 * climber to Home. The screen itself lives in the Discover tab.
 */
export default function SetterLinkRoute() {
  const { username } = useLocalSearchParams<{ username: string }>();
  return <Redirect href={{ pathname: '/(tabs)/discover/setter/[username]', params: { username } }} withAnchor />;
}
