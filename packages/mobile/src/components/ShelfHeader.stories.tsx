import { StyleSheet, View } from 'react-native';
import type { StoryModule } from '../dev/stories/types';
import { StoryPage, StoryPageLabel } from '../dev/stories/StoryPage';
import { useTheme } from '../providers/theme-provider';
import { spacing } from '../theme/tokens';
import { Icon } from './Icon';
import { PressableSurface } from './PressableSurface';
import { InsetGroupedList } from './InsetGroupedList';
import { ArtRow } from './ArtRow';
import { ShelfHeader, ShelfSection } from './ShelfHeader';

const noop = () => {};
const SEE_ALL = { label: 'See all', onPress: noop, accessibilityLabel: 'See all boards near you' };

function ShelfTiles() {
  const { surfaces } = useTheme();
  return (
    <View style={styles.tiles}>
      {[0, 1, 2].map((index) => (
        <View key={index} style={[styles.tile, { backgroundColor: surfaces.plain.card }]} />
      ))}
    </View>
  );
}

function HeaderStates() {
  const { systemColors } = useTheme();
  return (
    <StoryPage ground="plain">
      <StoryPageLabel>Title</StoryPageLabel>
      <ShelfHeader title="Your boards" />
      <StoryPageLabel>Title and caption</StoryPageLabel>
      <ShelfHeader title="Near you" caption="Boards within 5 km of you" />
      <StoryPageLabel>See all</StoryPageLabel>
      <ShelfHeader title="Near you" action={SEE_ALL} />
      <StoryPageLabel>Caption and See all</StoryPageLabel>
      <ShelfHeader title="Near you" caption="Boards within 5 km of you" action={SEE_ALL} />
      <StoryPageLabel>Long title wraps, action holds</StoryPageLabel>
      <ShelfHeader title="Boards at Bergen Klatresenter Danmarksplass" action={SEE_ALL} />
      <StoryPageLabel>Trailing node</StoryPageLabel>
      <ShelfHeader
        title="Your boards"
        trailing={
          <PressableSurface onPress={noop} feedback="opacity" hitSlop={12} accessibilityLabel="More">
            <Icon name="more" size={20} color={systemColors.accent} />
          </PressableSurface>
        }
      />
    </StoryPage>
  );
}

function ShelfStack() {
  const { systemColors } = useTheme();
  return (
    <StoryPage ground="plain">
      {/* One column, so the page's own gap stays out of the 8pt and 28pt being judged. */}
      <View>
        <ShelfSection title="Recently climbed" action={SEE_ALL}>
          <ShelfTiles />
        </ShelfSection>
        <ShelfSection title="Your boards" caption="Last used first">
          <View style={styles.inset}>
            <InsetGroupedList>
              <ArtRow
                art={<Icon name="boards" size={24} color={systemColors.secondaryLabel} />}
                artSize="regular"
                title="Garage Board"
                subtitle="Kilter · 40°"
                accessory="chevron"
                onPress={noop}
              />
              <ArtRow
                art={<Icon name="boards" size={24} color={systemColors.secondaryLabel} />}
                artSize="regular"
                title="Club wall"
                subtitle="Tension · 7 x 10"
                accessory="chevron"
                onPress={noop}
              />
            </InsetGroupedList>
          </View>
        </ShelfSection>
        <ShelfSection title="Fresh beta">
          <ShelfTiles />
        </ShelfSection>
      </View>
    </StoryPage>
  );
}

const styles = StyleSheet.create({
  tiles: {
    flexDirection: 'row',
    gap: spacing[3],
    paddingHorizontal: spacing[4],
  },
  tile: {
    width: 128,
    height: 160,
    borderRadius: 12,
  },
  inset: {
    paddingHorizontal: spacing[4],
  },
});

const stories: StoryModule = {
  title: 'Velvet / Shelf header',
  stories: {
    states: { name: 'Header states', layout: 'fullscreen', render: () => <HeaderStates /> },
    sections: { name: 'Shelf spacing (8pt in, 28pt between)', layout: 'fullscreen', render: () => <ShelfStack /> },
  },
};
export default stories;
