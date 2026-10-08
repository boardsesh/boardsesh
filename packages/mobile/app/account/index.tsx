import { UserDrawerScreen } from '../user-drawer';
import { holdUntilLaunchReady } from '../../src/components/launch-update/hold-until-launch-ready';

function AccountScreen() {
  return <UserDrawerScreen presentation="account" />;
}
export default holdUntilLaunchReady(AccountScreen);
