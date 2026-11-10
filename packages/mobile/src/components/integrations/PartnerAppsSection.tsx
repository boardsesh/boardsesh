import { memo, useCallback, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import {
  buildConnectedAppsSection,
  type ConnectedAppRowView,
  type ConnectedAppsFormatters,
  type ConnectedAppsSectionView,
  type ConnectedAppsTranslate,
} from '@boardsesh/connected-apps';
import { Icon } from '../Icon';
import { ListRow } from '../ListRow';
import { SectionHeader } from '../SectionHeader';
import { Text } from '../Text';
import { useAuth } from '../../providers/auth-provider';
import { useTheme } from '../../providers/theme-provider';
import { nowMs } from '../../lib/clock';
import { formatRelativeTime } from '../../lib/format-relative-time';
import { useMyConnectedApps } from '../../lib/graphql/hooks/use-connected-apps';
import { scopedRouter as router } from '../../lib/routing/scoped-navigation';
import { borderRadius, spacing } from '../../theme/tokens';

/** The dates in the climber's language, with mobile's clock (frozen in screenshot mode). */
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

type PartnerAppsSectionViewProps = {
  section: ConnectedAppsSectionView;
  onOpen: (row: ConnectedAppRowView) => void;
};

export function PartnerAppsSectionView({ section, onOpen }: PartnerAppsSectionViewProps) {
  const { systemColors } = useTheme();
  if (section.kind === 'hidden') return null;
  const cardBackground = { backgroundColor: systemColors.secondaryGroupedBackground };

  return (
    <View style={styles.section} testID="partner-apps-section">
      <SectionHeader title={section.title} />
      {section.kind === 'empty' ? (
        <View style={[styles.card, styles.paddedCard, cardBackground]}>
          <Text variant="subheadline" color={systemColors.secondaryLabel}>
            {section.message}
          </Text>
        </View>
      ) : (
        <View style={[styles.card, cardBackground]}>
          {section.rows.map((row, index) => (
            <PartnerAppRow
              key={row.connectionId}
              row={row}
              showSeparator={index < section.rows.length - 1}
              onOpen={onOpen}
            />
          ))}
        </View>
      )}
    </View>
  );
}

type PartnerAppRowProps = {
  row: ConnectedAppRowView;
  showSeparator: boolean;
  onOpen: (row: ConnectedAppRowView) => void;
};

const PartnerAppRow = memo(function PartnerAppRow({ row, showSeparator, onOpen }: PartnerAppRowProps) {
  const { systemColors, brandColors } = useTheme();
  const handlePress = useCallback(() => onOpen(row), [onOpen, row]);
  const suspended = row.suspendedNotice !== null;
  return (
    <ListRow
      title={row.name}
      subtitle={row.summary}
      leading={
        <Icon
          name={suspended ? 'warning' : 'link'}
          size={20}
          color={suspended ? brandColors.warning : systemColors.secondaryLabel}
        />
      }
      showChevron
      showSeparator={showSeparator}
      separatorInset={52}
      onPress={handlePress}
      testID={`partner-app-${row.connectionId}`}
    />
  );
});

const styles = StyleSheet.create({
  section: {
    width: '100%',
    marginBottom: spacing[6],
  },
  card: {
    overflow: 'hidden',
    borderRadius: borderRadius.lg,
    marginHorizontal: spacing[4],
  },
  paddedCard: {
    padding: spacing[4],
  },
});
