import { View, type ColorValue } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { BoardPresenceHardestSend } from '@boardsesh/shared-schema';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { PressableAvatar } from '../PressableAvatar';
import { withAlpha } from '../../theme/colors';
import { styles } from './wall-panel-styles';
type StatTileProps = {
  value: string;
  label: string;
  surfaceColor: ColorValue;
  labelColor: ColorValue;
  valueColor: ColorValue;
};

export function WallStatTile({ value, label, surfaceColor, labelColor, valueColor }: StatTileProps) {
  return (
    <View style={[styles.statTile, { backgroundColor: surfaceColor }]}>
      <Text variant="title3" color={valueColor} numberOfLines={1}>
        {value}
      </Text>
      <Text variant="caption1" color={labelColor} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

type HardestSendRowProps = {
  hardestSend: BoardPresenceHardestSend;
  labelColor: ColorValue;
  secondaryColor: ColorValue;
  surfaceColor: ColorValue;
  crownColor: string;
  formattedGrade: string;
  gradeColor: string;
};

export function WallHardestSendRow({
  hardestSend,
  labelColor,
  secondaryColor,
  surfaceColor,
  crownColor,
  formattedGrade,
  gradeColor,
}: HardestSendRowProps) {
  const { t } = useTranslation('session');
  const climberName = hardestSend.sentByDisplayName?.trim();

  return (
    <View style={[styles.hardestSendRow, { backgroundColor: surfaceColor }]}>
      <View style={styles.hardestAvatar}>
        <PressableAvatar
          userId={hardestSend.sentByUserId}
          uri={hardestSend.sentByAvatarUrl}
          name={climberName}
          size={34}
        />
        <View style={[styles.crownBadge, { backgroundColor: withAlpha(crownColor, 0.18) }]}>
          <Icon name="crown.fill" size={11} color={crownColor} />
        </View>
      </View>
      <View style={styles.hardestBody}>
        <Text variant="caption1" color={secondaryColor} numberOfLines={1}>
          {t('mobile.boardPresence.hardestSendLabel')}
        </Text>
        <Text variant="subheadline" color={labelColor} numberOfLines={1} style={styles.hardestName}>
          {hardestSend.name ?? ''}
        </Text>
        {climberName ? (
          <Text variant="caption1" color={secondaryColor} numberOfLines={1}>
            {t('mobile.boardPresence.sentByLine', { name: climberName })}
          </Text>
        ) : null}
      </View>
      <Text variant="headline" style={[styles.historyGrade, { color: gradeColor }]}>
        {formattedGrade}
      </Text>
    </View>
  );
}
