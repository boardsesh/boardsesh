import { STORY_BOARDS } from '../../dev/fixtures/boards';
import type { StoryModule } from '../../dev/stories/types';
import { PlayerScene, type PlayerSceneState } from '../../dev/stories/PlayerScene';
const states: readonly PlayerSceneState[] = ['lit', 'preview', 'crew', 'dark', 'disconnected', 'busy'];
const stories: StoryModule = {
  title: 'Player',
  stories: Object.fromEntries([
    ...states.map((state) => [
      state,
      {
        name: state,
        layout: 'fullscreen' as const,
        readiness: 'explicit' as const,
        render: (controls: import('../../dev/stories/types').StoryRenderControls) => (
          <PlayerScene {...controls} state={state} />
        ),
      },
    ]),
    ...Object.entries(STORY_BOARDS).map(([id, fixture]) => [
      id,
      {
        name: id,
        layout: 'fullscreen' as const,
        readiness: 'explicit' as const,
        render: (controls: import('../../dev/stories/types').StoryRenderControls) => (
          <PlayerScene {...controls} fixture={fixture} />
        ),
      },
    ]),
  ]),
};
export default stories;
