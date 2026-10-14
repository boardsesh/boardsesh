import { useProfile, useIsAdmin } from '../../../lib/graphql/hooks';
import { isPreviewBuild } from '../../../lib/preview-build';
import { useBottomChromeDiagnosticsEligible } from '../../BottomChromeDebugOverlay';

export type DeveloperSettingsAccess = {
  /**
   * Dev, testers and admins: the Development tools. The section can never come
   * out empty, because the "Force server unreachable" switch is there for
   * everyone who passes this gate, in every build.
   */
  showDevTools: boolean;
  /** EAS preview dev-client builds: the branch switcher. */
  showPreviewBuild: boolean;
  /**
   * The tab-bar geometry overlay. Its own audience (dev, preview builds and
   * pr-channel OTA testers), which is wider than the tester flag: a climber
   * testing a PR preview gets it without being a tester.
   */
  showBottomChromeDiagnostics: boolean;
  /** The Developer page has something to show. */
  allowed: boolean;
  /** Not allowed yet, but the profile or admin answer that could allow it is still loading. */
  loading: boolean;
  isTester: boolean;
  isAdmin: boolean;
};

/**
 * Who gets the Developer page. The Settings root uses it to show the row, and
 * the page uses it as its route guard: hiding the row is not a guard, since a
 * deep link reaches the route directly.
 */
export function useDeveloperSettingsAccess(): DeveloperSettingsAccess {
  const { data: profile, isLoading: profileLoading } = useProfile();
  // Its own query, deliberately not a field on the profile document (see
  // useIsAdmin). Fails closed, so an older backend just hides the admin rows.
  const { isAdmin, isLoading: adminLoading } = useIsAdmin();
  const isTester = Boolean(profile?.isTester);
  const showDevTools = __DEV__ || isTester || isAdmin;
  const showPreviewBuild = isPreviewBuild();
  const showBottomChromeDiagnostics = useBottomChromeDiagnosticsEligible();
  const allowed = showDevTools || showPreviewBuild || showBottomChromeDiagnostics;
  return {
    showDevTools,
    showPreviewBuild,
    showBottomChromeDiagnostics,
    allowed,
    loading: !allowed && (profileLoading || adminLoading),
    isTester,
    isAdmin,
  };
}
