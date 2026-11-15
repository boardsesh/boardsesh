import type { StoryModule } from '../../dev/stories/types';
import { RestTimerScene } from '../../dev/stories/RestTimerScene';
const stories: StoryModule = {
  title: 'Rest timer / Who moves the wall',
  stories: {
    sheetInACrew: {
      name: 'Crew of two',
      readiness: 'explicit',
      render: ({ onReady }) => <RestTimerScene onReady={onReady} role="passenger" />,
    },
    sheetSolo: { name: 'Solo', readiness: 'explicit', render: ({ onReady }) => <RestTimerScene onReady={onReady} /> },
  },
};
export default stories;
