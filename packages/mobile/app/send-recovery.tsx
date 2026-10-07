import { SendRecoveryScreen } from '../src/components/offline/SendRecoveryScreen';
import { holdUntilLaunchReady } from '../src/components/launch-update/hold-until-launch-ready';

function SendRecoveryRoute() {
  return <SendRecoveryScreen />;
}

// iOS presents this route as a native modal, above the launch update
// placeholder, and a URL can open it on a cold start. Held until launch is
// ready so a gate reload cannot land mid-tap (#6006).
export default holdUntilLaunchReady(SendRecoveryRoute);
