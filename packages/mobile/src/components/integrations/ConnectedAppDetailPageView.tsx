import type { ConnectedAppDetailView, ConnectedAppRowView } from '@boardsesh/connected-apps';
import { useCallback } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import { ActivityIndicator } from '../ActivityIndicator';
import { Button } from '../Button';
import { Icon } from '../Icon';
import { SectionHeader } from '../SectionHeader';
import { Text } from '../Text';
export type ConnectedAppDetailPageViewProps = {
  scrollBottomPadding: number;
  detail: ConnectedAppDetailView;
  onDisconnect: (row: ConnectedAppRowView) => void;
  disconnecting: boolean;
  /** Loads the list again after a failed first load. */
  onRetry: () => void;
};

export function ConnectedAppDetailPageView({
  detail,
  onDisconnect,
  disconnecting,
  onRetry,
  scrollBottomPadding,
}: ConnectedAppDetailPageViewProps) {
  const { systemColors, brandColors } = useTheme();
  const pageStyle = { backgroundColor: systemColors.groupedBackground };
  const cardBackground = { backgroundColor: systemColors.secondaryGroupedBackground };
  const handleDisconnect = useCallback(() => {
    if (detail.kind === 'app') onDisconnect(detail.row);
  }, [detail, onDisconnect]);

  if (detail.kind === 'loading') {
    return (
      <View style={[styles.page, styles.centered, pageStyle]}>
        <ActivityIndicator />
      </View>
    );
  }
  if (detail.kind === 'error') {
    return (
      <View style={[styles.page, styles.centered, pageStyle]}>
        <Text variant="body" color={systemColors.secondaryLabel} style={styles.message}>
          {detail.message}
        </Text>
        <Button title={detail.retryLabel} variant="outlined" size="small" onPress={onRetry} />
      </View>
    );
  }
  if (detail.kind === 'gone') {
    return (
      <View style={[styles.page, pageStyle]}>
        <Text variant="body" color={systemColors.secondaryLabel} style={styles.message}>
          {detail.message}
        </Text>
      </View>
    );
  }

  const { row } = detail;
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={pageStyle}
      contentContainerStyle={[styles.container, { paddingBottom: scrollBottomPadding + spacing[4] }]}
      testID="connected-app-detail"
    >
      <View style={[styles.card, styles.paddedCard, cardBackground]}>
        <Text variant="title3">{row.name}</Text>
        {row.publisher ? (
          <Text variant="subheadline" color={systemColors.secondaryLabel}>
            {row.publisher}
          </Text>
        ) : null}
        <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.when}>
          {row.connected}
        </Text>
        <Text variant="subheadline" color={systemColors.secondaryLabel}>
          {row.lastUsed}
        </Text>
        {row.suspendedNotice ? (
          <View style={[styles.notice, { backgroundColor: systemColors.tertiaryGroupedBackground }]}>
            <Icon name="warning" size={18} color={brandColors.warning} />
            <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.noticeText}>
              {row.suspendedNotice}
            </Text>
          </View>
        ) : null}
      </View>

      <View style={styles.section}>
        <SectionHeader title={detail.scopesHeading} />
        <View style={[styles.card, styles.paddedCard, styles.scopes, cardBackground]}>
          {row.scopes.map((scope) => (
            <View key={scope.scope} style={styles.scopeRow}>
              <Icon name="check.small" size={16} color={brandColors.primary} />
              <View style={styles.scopeText}>
                <Text variant="body">{scope.label}</Text>
                {scope.notes.map((note) => (
                  <Text key={note} variant="footnote" color={systemColors.secondaryLabel}>
                    {note}
                  </Text>
                ))}
              </View>
            </View>
          ))}
        </View>
        <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.footer}>
          {detail.footer}
        </Text>
      </View>

      {/* Disconnect in a card of its own, like Strava's, so the destructive action stands apart. */}
      <View style={[styles.card, styles.disconnectCard, cardBackground]}>
        <Button
          title={row.disconnectLabel}
          accessibilityLabel={row.disconnectAccessibilityLabel}
          variant="text"
          role="destructive"
          loading={disconnecting}
          disabled={disconnecting}
          onPress={handleDisconnect}
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
  },
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  message: {
    padding: spacing[4],
  },
  container: {
    width: '100%',
    maxWidth: 672,
    alignSelf: 'center',
    flexGrow: 1,
    paddingTop: spacing[4],
  },
  section: {
    marginTop: spacing[6],
  },
  card: {
    overflow: 'hidden',
    borderRadius: borderRadius.lg,
    marginHorizontal: spacing[4],
  },
  paddedCard: {
    padding: spacing[4],
  },
  when: {
    marginTop: spacing[2],
  },
  notice: {
    marginTop: spacing[3],
    borderRadius: borderRadius.md,
    padding: spacing[3],
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
  },
  noticeText: {
    flex: 1,
  },
  scopes: {
    gap: spacing[3],
  },
  scopeRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing[2],
  },
  scopeText: {
    flex: 1,
    gap: 2,
  },
  footer: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
  },
  disconnectCard: {
    marginTop: spacing[6],
    alignItems: 'flex-start',
    paddingHorizontal: spacing[2],
  },
});
