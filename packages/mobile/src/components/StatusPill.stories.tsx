import { StyleSheet, View } from 'react-native';
import type { StoryModule } from '../dev/stories/types';
import { StoryPage, StoryPageLabel } from '../dev/stories/StoryPage';
import { useTheme } from '../providers/theme-provider';
import { spacing } from '../theme/tokens';
import { ArtRow } from './ArtRow';
import { Icon } from './Icon';
import { InsetGroupedList } from './InsetGroupedList';
import { StatusPill } from './StatusPill';
import { TextAction } from './TextAction';

const noop = () => {};

function PillStates() {
  const { systemColors } = useTheme();
  const boardGlyph = <Icon name="boards" size={22} color={systemColors.secondaryLabel} />;
  return (
    <StoryPage ground="grouped">
      <StoryPageLabel>Alone</StoryPageLabel>
      <View style={styles.pills}>
        <StatusPill label="Closest" />
        <StatusPill label="Ready to review" />
        <StatusPill label="On it" />
      </View>

      <StoryPageLabel>Beside a tappable accent</StoryPageLabel>
      <View style={styles.pills}>
        <StatusPill label="Closest" />
        <TextAction label="Map" onPress={noop} chevron />
      </View>

      <StoryPageLabel>The title gives way first</StoryPageLabel>
      <View style={styles.inset}>
        <InsetGroupedList>
          <ArtRow
            art={boardGlyph}
            artSize="regular"
            title="Tension 2 Mirror at Boardsesh QA gym"
            subtitle="Tension · 12 x 12"
            status={<StatusPill label="Closest" />}
            accessory="chevron"
            onPress={noop}
          />
          <ArtRow
            art={boardGlyph}
            artSize="regular"
            title="Bergen Klatresenter Danmarksplass Kilter Original 12 x 12"
            subtitle="Kilter · 40°"
            status={<StatusPill label="Ready to review" />}
            accessory="chevron"
            onPress={noop}
          />
        </InsetGroupedList>
      </View>
    </StoryPage>
  );
}

const styles = StyleSheet.create({
  pills: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[4],
  },
  inset: {
    paddingHorizontal: spacing[4],
  },
});

const stories: StoryModule = {
  title: 'Velvet / Status pill',
  stories: {
    states: { name: 'Status pills', layout: 'fullscreen', render: () => <PillStates /> },
  },
};
export default stories;
