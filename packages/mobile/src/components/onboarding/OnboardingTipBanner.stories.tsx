import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { StoryModule } from '../../dev/stories/types';
import { spacing } from '../../theme/tokens';
import { TabBarHideFollower } from '../navigation/TabBarHideFollower';
import { OnboardingTipBanner } from './OnboardingTipBanner';

function AccessoryTipStory() {
  const { t } = useTranslation('common');
  const [visible, setVisible] = useState(true);
  const dismiss = () => setVisible(false);
  return (
    <View style={styles.screen}>
      {visible && (
        <TabBarHideFollower zIndex={100}>
          <View pointerEvents="box-none" style={styles.overlay}>
            <OnboardingTipBanner
              text={t('mobile.onboarding.tips.accessory')}
              dismissLabel={t('actions.close')}
              onDismiss={dismiss}
              onPress={dismiss}
              icon="chevron.down"
              solid
            />
          </View>
        </TabBarHideFollower>
      )}
    </View>
  );
}

const stories: StoryModule = {
  title: 'Onboarding / Bottom-bar hint',
  stories: {
    accessory: {
      name: 'Dismiss the bottom-bar hint',
      layout: 'fullscreen',
      render: () => <AccessoryTipStory />,
    },
  },
};
export default stories;

const styles = StyleSheet.create({
  screen: { flex: 1 },
  overlay: { position: 'absolute', left: spacing[3], right: spacing[3], bottom: 160 },
});
