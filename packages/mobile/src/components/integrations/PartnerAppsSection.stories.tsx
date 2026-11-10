import { useEffect, useMemo } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import {
  buildConnectedAppsSection,
  connectedAppDisconnectPrompt,
  type ConnectedAppsFacts,
  type ConnectedAppsSectionView,
  type ConnectedAppsTranslate,
} from '@boardsesh/connected-apps';
import type { StoryModule } from '../../dev/stories/types';
import { useConfirm } from '../../providers/dialog-provider';
import { useTheme } from '../../providers/theme-provider';
import { nowMs } from '../../lib/clock';
import { formatRelativeTime } from '../../lib/format-relative-time';
import { spacing, borderRadius } from '../../theme/tokens';
import { Icon } from '../Icon';
import { ListRow } from '../ListRow';
import { SectionHeader } from '../SectionHeader';
import { Text } from '../Text';
import { PartnerAppsSectionView } from './PartnerAppsSection';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function twoApps(): ConnectedAppsFacts {
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
        suspended: false,
      },
    ],
  };
}

/** The section built exactly as `PartnerAppsSection` builds it, from fixed data instead of the server. */
function useStorySection(data: ConnectedAppsFacts): ConnectedAppsSectionView {
  const { t, i18n } = useTranslation('settings');
  const locale = i18n.language;
  return useMemo(
    () =>
      buildConnectedAppsSection({
        signedIn: true,
        data,
        t: t as ConnectedAppsTranslate,
        formatters: {
          date: (iso) => new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }),
          relativeTime: formatRelativeTime,
          nowMs: nowMs(),
        },
      }),
    [data, t, locale],
  );
}

/** The Connected apps page's grouped background and width, with only this section on it. */
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

function SectionStory({ data }: { data: ConnectedAppsFacts }) {
  const section = useStorySection(data);
  return (
    <StoryPage>
      <PartnerAppsSectionView section={section} onDisconnect={() => {}} disconnectingId={null} />
    </StoryPage>
  );
}

/** The confirmation Disconnect raises, opened as soon as the story paints. */
function DisconnectPromptStory() {
  const { t } = useTranslation('settings');
  const confirm = useConfirm();
  const data = useMemo(twoApps, []);
  const section = useStorySection(data);
  useEffect(() => {
    void confirm({
      ...connectedAppDisconnectPrompt({ name: 'Sequence' }, t as ConnectedAppsTranslate),
      destructive: true,
    });
  }, [confirm, t]);
  return (
    <StoryPage>
      <PartnerAppsSectionView section={section} onDisconnect={() => {}} disconnectingId={null} />
    </StoryPage>
  );
}

/**
 * Option B, for the owner to compare (not shipped): one compact row per app
 * with when it was last used, and the detail one tap in.
 */
function CompactOptionStory() {
  const { systemColors } = useTheme();
  const section = useStorySection(useMemo(twoApps, []));
  if (section.kind !== 'list') return null;
  return (
    <StoryPage>
      <SectionHeader title={section.title} />
      <View style={[styles.card, { backgroundColor: systemColors.secondaryGroupedBackground }]}>
        {section.rows.map((row, index) => (
          <ListRow
            key={row.connectionId}
            title={row.name}
            subtitle={row.lastUsed}
            leading={<Icon name="link" size={20} color={systemColors.secondaryLabel} />}
            showChevron
            showSeparator={index < section.rows.length - 1}
            onPress={() => {}}
          />
        ))}
      </View>
      <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.footer}>
        {section.footer}
      </Text>
    </StoryPage>
  );
}

const stories: StoryModule = {
  title: 'Settings / Connected apps / Apps with access',
  stories: {
    twoApps: {
      name: 'Two connected apps (option A: everything on the page)',
      layout: 'fullscreen',
      render: () => <SectionStory data={twoApps()} />,
    },
    suspended: {
      name: 'An app Boardsesh suspended',
      layout: 'fullscreen',
      render: () => (
        <SectionStory
          data={{ ...twoApps(), apps: twoApps().apps.map((app, index) => ({ ...app, suspended: index === 1 })) }}
        />
      ),
    },
    empty: {
      name: 'Nothing connected, partner apps on',
      layout: 'fullscreen',
      render: () => <SectionStory data={{ apps: [], partnerAppsEnabled: true }} />,
    },
    disconnectPrompt: {
      name: 'Disconnect asks first',
      layout: 'fullscreen',
      render: () => <DisconnectPromptStory />,
    },
    compactOption: {
      name: 'Option B: one row per app, detail one tap in',
      layout: 'fullscreen',
      render: () => <CompactOptionStory />,
    },
  },
};

export default stories;

const styles = StyleSheet.create({
  page: {
    paddingTop: spacing[4],
    paddingBottom: spacing[8],
  },
  card: {
    overflow: 'hidden',
    borderRadius: borderRadius.lg,
    marginHorizontal: spacing[4],
  },
  footer: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
  },
});
