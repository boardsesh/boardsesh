import { Redirect } from 'expo-router';

export default function NotFound() {
  return <Redirect href="/(tabs)/home" />;
}
