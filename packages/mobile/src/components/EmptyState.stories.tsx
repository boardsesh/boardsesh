import type { StoryModule } from '../dev/stories/types';
import { StoryPage, StoryPageLabel } from '../dev/stories/StoryPage';
import { Button } from './Button';
import { EmptyState } from './EmptyState';
import { ShelfHeader } from './ShelfHeader';
import { TextAction } from './TextAction';

const noop = () => {};

const stories: StoryModule = {
  title: 'Velvet / Empty state',
  stories: {
    screen: {
      name: 'Screen',
      layout: 'fullscreen',
      render: () => (
        <EmptyState
          size="screen"
          icon="boards"
          title="No boards yet"
          body="Add the board you climb on, or find one at your gym."
          actions={<Button title="Add a board" onPress={noop} variant="filled" />}
        />
      ),
    },
    section: {
      name: 'Section and quiet',
      layout: 'fullscreen',
      render: () => (
        <StoryPage ground="plain">
          <StoryPageLabel>Section</StoryPageLabel>
          <ShelfHeader title="Your sends" />
          <EmptyState
            size="section"
            icon="tick"
            title="No sends this week"
            body="Log a tick from the player and it shows up here."
            actions={<Button title="Browse climbs" onPress={noop} variant="outlined" />}
          />
          <StoryPageLabel>Quiet, with an action</StoryPageLabel>
          <ShelfHeader title="Near you" />
          <EmptyState
            size="quiet"
            title="No boards found near you."
            actions={<TextAction label="Retry" onPress={noop} />}
          />
          <StoryPageLabel>Quiet, alone</StoryPageLabel>
          <ShelfHeader title="Fresh beta" />
          <EmptyState size="quiet" title="No new beta videos for this board." />
        </StoryPage>
      ),
    },
  },
};
export default stories;
