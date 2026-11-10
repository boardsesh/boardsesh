import { useEffect, useMemo } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import {
  buildConnectedAppDetail,
  buildConnectedAppsSection,
  connectedAppDisconnectPrompt,
  type ConnectedAppsFacts,
  type ConnectedAppsTranslate,
} from '@boardsesh/connected-apps';
import type { StoryModule } from '../../dev/stories/types';
import { useConfirm } from '../../providers/dialog-provider';
import { useTheme } from '../../providers/theme-provider';
import { nowMs } from '../../lib/clock';
import { spacing } from '../../theme/tokens';
import { ConnectedAppDetailPage } from './ConnectedAppDetailScreen';
import { PartnerAppsSectionView, useConnectedAppsFormatters } from './PartnerAppsSection';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function twoApps({ suspendSecond = false } = {}): ConnectedAppsFacts {
  const now = nowMs();
  return {
    partnerAppsEnabled: true,
    apps: [
      {
        connectionId: 'story-sequence',
        name: 'Sequence',
        publisherName: null,
        scopes: ['profile:read', 'logbook:read', 'offline_access'],
        connectedAt: new Date(now - 26 * DAY_MS).toISOString(),
        lastUsedAt: new Date(now - 3 * HOUR_MS).toISOString(),
        suspended: false,
      },
      {
        connectionId: 'story-divepeaks',
        name: 'DivePeaks',
        publisherName: null,
        scopes: ['logbook:read', 'offline_access'],
        connectedAt: new Date(now - 70 * DAY_MS).toISOString(),
        lastUsedAt: new Date(now - 2 * DAY_MS).toISOString(),
        suspended: suspendSecond,
      },
    ],
  };
}

/** The Connected apps page's grouped background, with only this section on it. */
function StoryPage({ children }: { children: React.ReactNode }) {
  const { systemColors } = useTheme();
  return (
    <ScrollView
      style={{ backgroundColor: systemColors.groupedBackground }}
      contentContainerStyle={styles.page}
      contentInsetAdjustmentBehavior="automatic"
    >
      {children}
    </ScrollView>
  );
}

/** The list exactly as `PartnerAppsSection` builds it, from fixed data instead of the server. */
function ListStory({ data }: { data: ConnectedAppsFacts }) {
  const { t } = useTranslation('settings');
  const formatters = useConnectedAppsFormatters();
  const section = useMemo(
    () => buildConnectedAppsSection({ signedIn: true, data, t: t as ConnectedAppsTranslate, formatters }),
    [data, t, formatters],
  );
  return (
    <StoryPage>
      <PartnerAppsSectionView section={section} onOpen={() => {}} />
    </StoryPage>
  );
}

/** The detail page exactly as `ConnectedAppDetailScreen` builds it. `confirm` opens Disconnect's prompt. */
function DetailStory({
  connectionId,
  data,
  confirm = false,
}: {
  connectionId: string;
  data: ConnectedAppsFacts;
  confirm?: boolean;
}) {
  const { t } = useTranslation('settings');
  const formatters = useConnectedAppsFormatters();
  const ask = useConfirm();
  const detail = useMemo(
    () => buildConnectedAppDetail({ signedIn: true, data, connectionId, t: t as ConnectedAppsTranslate, formatters }),
    [data, connectionId, t, formatters],
  );
  useEffect(() => {
    if (!confirm || detail.kind !== 'app') return;
    void ask({
      ...connectedAppDisconnectPrompt({ name: detail.row.name }, t as ConnectedAppsTranslate),
      destructive: true,
    });
  }, [confirm, detail, ask, t]);
  return <ConnectedAppDetailPage detail={detail} onDisconnect={() => {}} disconnecting={false} onRetry={() => {}} />;
}

const stories: StoryModule = {
  title: 'Settings / Connected apps / Apps with access',
  stories: {
    list: {
      name: 'Two connected apps: one row each',
      layout: 'fullscreen',
      render: () => <ListStory data={twoApps()} />,
    },
    listSuspended: {
      name: 'Two apps, one suspended by Boardsesh',
      layout: 'fullscreen',
      render: () => <ListStory data={twoApps({ suspendSecond: true })} />,
    },
    empty: {
      name: 'Nothing connected, partner apps on',
      layout: 'fullscreen',
      render: () => <ListStory data={{ apps: [], partnerAppsEnabled: true }} />,
    },
    detail: {
      name: 'An app: what it can see, and Disconnect',
      layout: 'fullscreen',
      render: () => <DetailStory connectionId="story-sequence" data={twoApps()} />,
    },
    detailSuspended: {
      name: 'An app Boardsesh suspended',
      layout: 'fullscreen',
      render: () => <DetailStory connectionId="story-divepeaks" data={twoApps({ suspendSecond: true })} />,
    },
    disconnectPrompt: {
      name: 'Disconnect asks first',
      layout: 'fullscreen',
      render: () => <DetailStory connectionId="story-sequence" data={twoApps()} confirm />,
    },
  },
};

export default stories;

const styles = StyleSheet.create({
  page: {
    paddingTop: spacing[4],
    paddingBottom: spacing[8],
  },
});
