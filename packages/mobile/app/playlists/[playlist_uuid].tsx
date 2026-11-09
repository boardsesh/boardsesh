import { Redirect, useLocalSearchParams } from 'expo-router';

/**
 * Where a shared playlist link lands. The link is www's URL, and iOS hands it to
 * the app without loading the page, so without this route `+not-found` sends the
 * climber to Home. The screen itself lives in the Discover tab.
 */
export default function PlaylistLinkRoute() {
  const { playlist_uuid: playlistUuid } = useLocalSearchParams<{ playlist_uuid: string }>();
  return (
    <Redirect
      href={{ pathname: '/(tabs)/discover/[playlist_uuid]', params: { playlist_uuid: playlistUuid } }}
      withAnchor
    />
  );
}
