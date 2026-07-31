import React, { useMemo } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { AscentStatusValue } from '../lib/ascent-status-utils';
import { useAscentStatus } from '../hooks/use-ascent-status';
import { useTheme } from '../providers/theme-provider';
import { Icon } from './Icon';
import type { IconName } from './icon-map';

// Status is carried by glyph shape in a single neutral grey — not colour — so it
// cannot be confused with the colour-coded grade beside it and remains readable
// for colour-blind climbers. ⚡ flashed, ✓ sent, ✗ attempted.
const ASCENT_STATUS_ICON: Record<AscentStatusValue, IconName> = {
  flash: 'flash',
  send: 'tick.outline',
  attempt: 'ascent.attempt',
};

type AscentStatusGlyphProps = {
  climbUuid: string;
  angle: number;
  style?: StyleProp<ViewStyle>;
};

type AscentStatusMarkProps = {
  status: AscentStatusValue | null;
  style?: StyleProp<ViewStyle>;
};

/** Pure visual/semantic marker for callers that already own a status index. */
export const AscentStatusMark = React.memo(function AscentStatusMark({ status, style }: AscentStatusMarkProps) {
  const { t } = useTranslation('climbs');
  const theme = useTheme();

  const ascentStatusLabel = useMemo(() => {
    if (!status) return undefined;
    return {
      flash: t('mobile.climbRow.ascentStatus.flash'),
      send: t('mobile.climbRow.ascentStatus.send'),
      attempt: t('mobile.climbRow.ascentStatus.attempt'),
    }[status];
  }, [status, t]);

  if (!status) return null;
  return (
    <View style={style} accessibilityRole="image" accessibilityLabel={ascentStatusLabel}>
      <Icon name={ASCENT_STATUS_ICON[status]} size={16} color={theme.systemColors.secondaryLabel} />
    </View>
  );
});

/**
 * The compact, accessible prior-ascent marker shared by climb rows and the play
 * drawer. It alone subscribes to the pre-indexed logbook, leaving its parent
 * free of logbook updates and avoiding an O(logbook) scan during rendering.
 */
export const AscentStatusGlyph = React.memo(function AscentStatusGlyph({
  climbUuid,
  angle,
  style,
}: AscentStatusGlyphProps) {
  const ascentStatus = useAscentStatus(climbUuid, angle);
  return <AscentStatusMark status={ascentStatus} style={style} />;
});
