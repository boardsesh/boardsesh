import { Redirect, Stack } from 'expo-router';
import { loadIntegrationSmoke } from '../../../src/dev/integration/load';
/** Commands are handled by the persistent dev integration root across route changes. */
export default function VideoIntegrationRoute() {
  return loadIntegrationSmoke() ? <Stack.Screen options={{ headerShown: false }} /> : <Redirect href="/" />;
}
