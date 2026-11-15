import type { ConnectedAppRowView, ConnectedAppsSectionView } from '@boardsesh/connected-apps';
import { memo, useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';
import { Icon } from '../Icon';
import { ListRow } from '../ListRow';
import { SectionHeader } from '../SectionHeader';
import { Text } from '../Text';
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
