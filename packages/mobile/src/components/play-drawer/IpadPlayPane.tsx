import { memo } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PlayDrawer } from './PlayDrawer';
import { Icon } from '../Icon';
import { Text } from '../Text';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing } from '../../theme/tokens';

/**
 * The persistent right column on the iPad shell: the PlayDrawer for the current
 * climb, rendered as a pane (not a bottom sheet). It replaces the floating
 * accessory/queue bar at regular width. The drawer props come from
 * DrawerHostProvider so the pane and the compact bottom sheet stay identical;
 * the sheet is not mounted at regular width (see drawer-host-provider).
 */
function IpadPlayPaneComponent() {
  const { playDrawerPaneProps } = useDrawerHost();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation('session');

  // No board resolved yet — same placeholder the pane shows when no climb is set.
  if (!playDrawerPaneProps) {
    return (
      <View style={[styles.empty, { paddingTop: insets.top + spacing[8], paddingBottom: insets.bottom }]}>
        <Icon name="boards" size={40} color={iosSystemColors.systemGray4} />
        <Text variant="headline" style={styles.emptyTitle}>
          {t('playView.paneEmpty.title')}
        </Text>
        <Text variant="subheadline" style={styles.emptySubtitle}>
          {t('playView.paneEmpty.subtitle')}
        </Text>
      </View>
    );
  }

  return <PlayDrawer presentation="pane" {...playDrawerPaneProps} />;
}

export const IpadPlayPane = memo(IpadPlayPaneComponent);

const styles = StyleSheet.create({
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing[6],
    gap: spacing[2],
  },
  emptyTitle: { marginTop: spacing[2], opacity: 0.7, textAlign: 'center' },
  emptySubtitle: { opacity: 0.5, textAlign: 'center' },
});
