import { Redirect, useLocalSearchParams } from 'expo-router';

/** Public www profile links land in the Profile tab, with its root behind Back. */
export default function ProfileLinkRoute() {
  const { user_id: userId } = useLocalSearchParams<{ user_id: string }>();
  return <Redirect href={{ pathname: '/(tabs)/profile/users/[userId]', params: { userId } }} withAnchor />;
}
