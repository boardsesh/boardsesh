import { Redirect, useLocalSearchParams } from 'expo-router';

/** Public recap links open the session in Home, with its feed behind Back. */
export default function SessionLinkRoute() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  return <Redirect href={{ pathname: '/(tabs)/home/session/[sessionId]', params: { sessionId } }} withAnchor />;
}
