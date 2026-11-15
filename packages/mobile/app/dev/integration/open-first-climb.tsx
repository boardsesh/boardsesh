import { Redirect } from 'expo-router';
import { loadIntegrationSmoke } from '../../../src/dev/integration/load';

export default function OpenFirstClimbIntegrationRoute() {
  const smoke = loadIntegrationSmoke();
  return smoke ? <smoke.OpenFirstSmokeClimb /> : <Redirect href="/" />;
}
