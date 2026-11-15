import type { ComponentProps, ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { spacing } from '../../theme/tokens';
import { FeedScopeTitle } from '../feed/FeedScopeTitle';
import { Text } from '../Text';
import { HomeCustomizeButton } from './HomeCustomizeButton';
export function HomeHeaderView({
  scope,
  notices,
  sections,
  showCustomize,
  onCustomize,
  heading,
}: {
  scope?: ComponentProps<typeof FeedScopeTitle>;
  notices?: ReactNode;
  sections?: ReactNode;
  showCustomize: boolean;
  onCustomize: () => void;
  heading?: string;
}) {
  return (
    <View style={styles.header}>
      {scope ? (
        <View style={styles.scopePicker}>
          <FeedScopeTitle {...scope} />
        </View>
      ) : null}
      {notices}
      {sections}
      {showCustomize ? <HomeCustomizeButton onPress={onCustomize} /> : null}
      {heading ? (
        <Text variant="title3" style={styles.feedHeading}>
          {heading}
        </Text>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  header: { paddingTop: spacing[2] },
  scopePicker: { alignItems: 'flex-start', paddingHorizontal: spacing[4], paddingBottom: spacing[2] },
  feedHeading: { paddingHorizontal: spacing[4], paddingBottom: spacing[2] },
});
