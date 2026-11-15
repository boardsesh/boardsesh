import { CPP_STORY_SCENES, CPP_STORY_TARGETS, type CppStoryTarget } from '../fixtures/cpp-scenes';
import { createCppStoryPresentation } from '../fixtures/cpp-presentation';
import { StoryBoardFixtureContext } from './story-board-fixture';
import type { ComponentStory, StoryModule } from './types';
import filters from '../../components/climbs/ClimbFilters.stories';
import logbook from '../../components/you/Logbook.stories';
import queue from '../../components/play-drawer/QueueSheet.stories';
import workout from '../../components/session-screen/pre-session/WorkoutGenerator.stories';
import status from '../../components/board-presence/WallStatus.stories';
import kiosk from '../../components/board-presence/wall-kiosk/WallKiosk.stories';
import setting from '../../components/outline-editor/SprayEditor.stories';
import playlist from '../../components/playlist/PlaylistDetail.stories';
import pickers from '../../components/climbs/ClimbPickers.stories';

const scenes: Record<string, ComponentStory> = {
  search: filters.stories.open,
  logbook: logbook.stories.populated,
  queue: queue.stories['up-next'],
  workout: workout.stories.volume,
  status: status.stories.connected,
  kiosk: kiosk.stories.live,
  setting: setting.stories.setting,
  playlist: playlist.stories.populated,
  holds: pickers.stories.holds,
};
export default {
  title: 'Store / Custom product pages',
  stories: Object.fromEntries(
    (Object.keys(CPP_STORY_TARGETS) as CppStoryTarget[]).flatMap((target) => {
      const { label } = CPP_STORY_TARGETS[target];
      return CPP_STORY_SCENES[target].map((scene) => {
        const presentation = createCppStoryPresentation(target, scene);
        const source = scenes[scene];
        return [
          `${target}-${scene}`,
          {
            ...source,
            name: `${label} / ${scene}`,
            render: (controls) => (
              <StoryBoardFixtureContext value={presentation}>{source.render(controls)}</StoryBoardFixtureContext>
            ),
          } satisfies ComponentStory,
        ];
      });
    }),
  ),
} satisfies StoryModule;
