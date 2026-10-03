import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { useTheme } from '../../providers/theme-provider';
import { iosSystemColors } from '../../theme/ios-colors';

type StarNumberProps = {
  /** 1 to 5. Callers pass `effectiveQuality ?? quality`. Nullish or zero renders nothing. */
  quality: number | null | undefined;
};

/**
 * A star rating as one glyph and the number: "★ 4". The number carries the
 * rating, so the gold never has to clear contrast on its own.
 */
export const StarNumber = memo(function StarNumber({ quality }: StarNumberProps) {
  const { t } = useTranslation('session');
  const { colorScheme } = useTheme();
  if (quality == null || quality <= 0) return null;

  return (
    <View accessible accessibilityLabel={t('mobile.logbook.starsA11y', { count: quality })} style={styles.row}>
      <Icon
        name="star.fill"
        size={12}
        color={colorScheme === 'dark' ? iosSystemColors.starGold : iosSystemColors.starGoldOnLight}
      />
      <Text variant="footnote" style={styles.number}>
        {quality}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  number: {
    fontVariant: ['tabular-nums'],
  },
});
