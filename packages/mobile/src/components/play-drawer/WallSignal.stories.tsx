import type { StoryModule } from '../../dev/stories/types';
import { PlayerScene, type PlayerSceneState } from '../../dev/stories/PlayerScene';
const states: Record<string, PlayerSceneState> = {
  onWall: 'lit',
  previewNotLit: 'preview',
  onlyYou: 'crew',
  liveButDark: 'dark',
  noBoard: 'disconnected',
};
const stories: StoryModule = {
  title: 'Play drawer / Wall signal',
  stories: Object.fromEntries(
    Object.entries(states).map(([key, state]) => [
      key,
      {
        name: key,
        layout: 'fullscreen' as const,
        readiness: 'explicit' as const,
        render: (controls) => <PlayerScene {...controls} state={state} />,
      },
    ]),
  ),
};
export default stories;
