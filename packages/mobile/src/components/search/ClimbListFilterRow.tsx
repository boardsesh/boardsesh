import { memo, useCallback, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { scopedRouter } from '../../lib/routing/scoped-navigation';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { glassSize } from '../../theme/layout';
import { GlassIconButton } from '../GlassIconButton';

/** Keep display settings visible beside the scrolling chips, leaving the header
 *  width available for the current climb. Native and browser chip rows own their
 *  scrolling inside the bounded flex slot; the eye stays outside that scroller. */
export const ClimbListFilterRow = memo(function ClimbListFilterRow({ children }: { children: ReactNode }) {
  const { t } = useTranslation('common');
  const { systemColors } = useTheme();
  const openClimbListSettings = useCallback(() => scopedRouter.push('/settings/climb-list'), []);
  return (
    <View style={styles.row} testID="climb-list-filter-row">
      <View style={styles.chips} testID="climb-list-filter-chips">
        {children}
      </View>
      <View style={styles.action}>
        <GlassIconButton
          iconName="visibility"
          iconColor={systemColors.label}
          iconSize={22}
          size={glassSize.standard}
          fallbackColor={systemColors.fill}
          accessibilityLabel={t('mobile.settings.climbList.openLabel')}
          onPress={openClimbListSettings}
        />
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  chips: { flex: 1, minWidth: 0 },
  action: { flexShrink: 0, paddingRight: spacing[4] },
});
