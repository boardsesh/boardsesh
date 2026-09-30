import { Redirect } from 'expo-router';

/** The app always opens on the Home tab. */
export default function AppEntry() {
  return <Redirect href="/home" />;
}
