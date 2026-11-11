import type { StoryModule } from '../../dev/stories/types';
import { SprayWallLedSection } from './SprayWallLedSection';

const stories: StoryModule = {
  title: 'Spray wall / LED',
  stories: {
    setup: {
      name: 'One surface, WLED settings (no real wall, stays on this device)',
      render: () => <SprayWallLedSection wallUuid="dev-story-spray-led" />,
    },
  },
};

export default stories;
