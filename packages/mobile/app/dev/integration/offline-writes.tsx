import { Redirect } from 'expo-router';
import { loadOfflineWriteScreen } from '../../../src/dev/offline-writes/load';

export default function OfflineWriteIntegrationRoute() {
  const Screen = loadOfflineWriteScreen();
  return Screen ? <Screen /> : <Redirect href="/" />;
}
