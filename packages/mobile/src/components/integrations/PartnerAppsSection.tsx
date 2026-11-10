import { memo, useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import {
  buildConnectedAppsSection,
  connectedAppDisconnectPrompt,
  connectedAppDisconnectResult,
  type ConnectedAppRowView,
  type ConnectedAppsSectionView,
  type ConnectedAppsTranslate,
} from '@boardsesh/connected-apps';
import { Button } from '../Button';
import { Icon } from '../Icon';
import { SectionHeader } from '../SectionHeader';
import { Text } from '../Text';
import { useAuth } from '../../providers/auth-provider';
import { useConfirm } from '../../providers/dialog-provider';
import { useTheme } from '../../providers/theme-provider';
import { useToast } from '../../providers/toast-provider';
import { nowMs } from '../../lib/clock';
import { formatRelativeTime } from '../../lib/format-relative-time';
import { useDisconnectApp, useMyConnectedApps } from '../../lib/graphql/hooks/use-connected-apps';
import { borderRadius, spacing } from '../../theme/tokens';

/**
 * Apps the climber connected to their account through partner OAuth (#6981
 * F16): what each can read, when it connected and was last used, and
 * Disconnect. The words and the show-or-hide rule come from
 * `@boardsesh/connected-apps`, shared with the website; this file only draws them.
 */
export function PartnerAppsSection() {
  const { t, i18n } = useTranslation('settings');
  const { isAuthenticated } = useAuth();
  const { data } = useMyConnectedApps();
  const { disconnect, disconnectingId } = usePartnerAppDisconnect();
  const locale = i18n.language;

  const section = useMemo(
    () =>
      buildConnectedAppsSection({
        signedIn: isAuthenticated,
        data,
        t: t as ConnectedAppsTranslate,
        formatters: {
          date: (iso) => new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }),
          relativeTime: formatRelativeTime,
          nowMs: nowMs(),
        },
      }),
    [isAuthenticated, data, t, locale],
  );

  return <PartnerAppsSectionView section={section} onDisconnect={disconnect} disconnectingId={disconnectingId} />;
}

/** Confirm, then end the connection and say how it went. One handler for every row. */
export function usePartnerAppDisconnect() {
  const { t } = useTranslation('settings');
  const confirm = useConfirm();
  const { showToast } = useToast();
  const { mutate } = useDisconnectApp();
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const translate = t as ConnectedAppsTranslate;

  const disconnect = useCallback(
    async (row: ConnectedAppRowView) => {
      const prompt = connectedAppDisconnectPrompt({ name: row.name }, translate);
      const confirmed = await confirm({ ...prompt, destructive: true });
      if (!confirmed) return;
      setDisconnectingId(row.connectionId);
      mutate(
        { connectionId: row.connectionId },
        {
          onSuccess: () =>
            showToast(connectedAppDisconnectResult({ name: row.name }, 'disconnected', translate), 'success'),
          onError: () => showToast(connectedAppDisconnectResult({ name: row.name }, 'failed', translate), 'error'),
          onSettled: () => setDisconnectingId(null),
        },
      );
    },
    [confirm, mutate, showToast, translate],
  );

  return { disconnect, disconnectingId };
}

type PartnerAppsSectionViewProps = {
  section: ConnectedAppsSectionView;
  onDisconnect: (row: ConnectedAppRowView) => void;
  /** The connection whose Disconnect is in flight. */
  disconnectingId: string | null;
};

export function PartnerAppsSectionView({ section, onDisconnect, disconnectingId }: PartnerAppsSectionViewProps) {
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
        <>
          {section.rows.map((row, index) => (
            <PartnerAppCard
              key={row.connectionId}
              row={row}
              isLast={index === section.rows.length - 1}
              disconnecting={disconnectingId === row.connectionId}
              onDisconnect={onDisconnect}
            />
          ))}
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.footer}>
            {section.footer}
          </Text>
        </>
      )}
    </View>
  );
}

type PartnerAppCardProps = {
  row: ConnectedAppRowView;
  isLast: boolean;
  disconnecting: boolean;
  onDisconnect: (row: ConnectedAppRowView) => void;
};

const PartnerAppCard = memo(function PartnerAppCard({ row, isLast, disconnecting, onDisconnect }: PartnerAppCardProps) {
  const { systemColors, brandColors } = useTheme();
  const handleDisconnect = useCallback(() => onDisconnect(row), [onDisconnect, row]);

  return (
    <View
      style={[
        styles.card,
        styles.paddedCard,
        !isLast && styles.cardSpacing,
        { backgroundColor: systemColors.secondaryGroupedBackground },
      ]}
      testID={`partner-app-${row.connectionId}`}
    >
      <Text variant="headline">{row.name}</Text>
      {row.publisher ? (
        <Text variant="subheadline" color={systemColors.secondaryLabel}>
          {row.publisher}
        </Text>
      ) : null}
      <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.when}>
        {`${row.connected} · ${row.lastUsed}`}
      </Text>

      {row.suspendedNotice ? (
        <View style={[styles.notice, { backgroundColor: systemColors.tertiaryGroupedBackground }]}>
          <Icon name="warning" size={18} color={brandColors.warning} />
          <Text variant="footnote" color={systemColors.secondaryLabel} style={styles.noticeText}>
            {row.suspendedNotice}
          </Text>
        </View>
      ) : null}

      <View style={styles.scopes}>
        {row.scopes.map((scope) => (
          <View key={scope.scope} style={styles.scopeRow}>
            <Icon name="check.small" size={16} color={brandColors.primary} />
            <View style={styles.scopeText}>
              <Text variant="subheadline">{scope.label}</Text>
              {scope.notes.map((note) => (
                <Text key={note} variant="footnote" color={systemColors.secondaryLabel}>
                  {note}
                </Text>
              ))}
            </View>
          </View>
        ))}
      </View>

      <View style={styles.actionRow}>
        <Button
          title={row.disconnectLabel}
          accessibilityLabel={row.disconnectAccessibilityLabel}
          variant="text"
          size="small"
          role="destructive"
          loading={disconnecting}
          disabled={disconnecting}
          onPress={handleDisconnect}
        />
      </View>
    </View>
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
  cardSpacing: {
    marginBottom: spacing[3],
  },
  when: {
    marginTop: spacing[1],
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
    marginTop: spacing[3],
    gap: spacing[2],
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
  actionRow: {
    flexDirection: 'row',
    marginTop: spacing[3],
  },
  footer: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[2],
  },
});
