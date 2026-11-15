import {
  buildConnectedAppsSection,
  type ConnectedAppRowView,
  type ConnectedAppsFormatters,
  type ConnectedAppsTranslate,
} from '@boardsesh/connected-apps';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { nowMs } from '../../lib/clock';
import { formatRelativeTime } from '../../lib/format-relative-time';
import { useMyConnectedApps } from '../../lib/graphql/hooks/use-connected-apps';
import { scopedRouter as router } from '../../lib/routing/scoped-navigation';
import { useAuth } from '../../providers/auth-provider';
import { PartnerAppsSectionView } from './PartnerAppsSectionView';
export { PartnerAppsSectionView } from './PartnerAppsSectionView';

/** The dates in the climber's language, with mobile's clock. */
export function useConnectedAppsFormatters(): ConnectedAppsFormatters {
  const { i18n } = useTranslation('settings');
  const locale = i18n.language;
  return useMemo(
    () => ({
      date: (iso) => new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }),
      relativeTime: formatRelativeTime,
      nowMs: nowMs(),
    }),
    [locale],
  );
}

/**
 * Apps the climber connected to their account through partner OAuth (#6981
 * F16), last on Settings › Connected apps: one row per app with when it was last
 * used, each opening the app's detail (`ConnectedAppDetailScreen`). The words and
 * the show-or-hide rule come from `@boardsesh/connected-apps`, shared with the
 * website; this file only draws them.
 */
export function PartnerAppsSection() {
  const { t } = useTranslation('settings');
  const { isAuthenticated } = useAuth();
  const { data } = useMyConnectedApps();
  const formatters = useConnectedAppsFormatters();

  const section = useMemo(
    () => buildConnectedAppsSection({ signedIn: isAuthenticated, data, t: t as ConnectedAppsTranslate, formatters }),
    [isAuthenticated, data, t, formatters],
  );
  const openApp = useCallback((row: ConnectedAppRowView) => {
    router.push({ pathname: '/settings/connected-app', params: { id: row.connectionId } });
  }, []);

  return <PartnerAppsSectionView section={section} onOpen={openApp} />;
}
