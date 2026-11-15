import { readFileSync } from 'node:fs';
import type { CppPage } from './screenshot-cpp';
import {
  CPP_STORY_SCENES,
  CPP_STORY_TARGETS,
  type CppStoryTarget,
} from '../../packages/mobile/src/dev/fixtures/cpp-scenes';

export interface VisualStoryCapture {
  name: string;
  storyId: string;
  nativeActivityBoard?: string;
}

/** Every shipping image names its view explicitly. Never substitute another board's geometry. */
const VIEW_BY_NAME: Record<string, string> = {
  home: 'home--feed',
  'home-live': 'home--feed',
  climbs: 'climbs--populated',
  search: 'climb-filters--open',
  discover: 'discover-library--library',
  profile: 'progress--overview',
  logbook: 'logbook--populated',
  'session-detail': 'workout-server-data--detail',
  'workout-generator': 'workout-generator--volume',
  workout: 'workout-generator--volume',
  'playlist-detail': 'playlist-detail--populated',
  playlist: 'playlist-detail--populated',
  'board-view': 'player--kilter',
  'board-view-2': 'player--tension',
  'kilter-board-view': 'player--kilter',
  'tension-board-view': 'player--tension',
  'moonboard-board-view': 'player--moonboard',
  'moonboard-2024-view': 'player--moonboard-2024',
  'woods-board-view': 'player--woods',
  'decoy-board-view': 'player--decoy',
  'grasshopper-board-view': 'player--grasshopper',
  'spray-board-view': 'player--spray',
  'board-sheet': 'board-selector--populated',
  wall: 'wall-kiosk--live',
  'wall-status': 'wall-status--connected',
  status: 'wall-status--connected',
  kiosk: 'wall-kiosk--live',
  'live-queue': 'queue-sheet--up-next',
  'crew-queue': 'queue-sheet--up-next',
  queue: 'queue-sheet--up-next',
  'holds-filter': 'climb-pickers--holds',
  holds: 'climb-pickers--holds',
  'zone-filter': 'climb-pickers--zone',
  setters: 'climb-pickers--setters',
  'share-beta': 'beta--share',
  'beta-shelf': 'beta--shelf',
  preview: 'player--preview',
  'board-lighting': 'board-lighting--settings',
  'climb-actions': 'climbs--actions',
  'onboarding-welcome': 'onboarding--welcome',
  'onboarding-board-history': 'onboarding--board-history',
  setting: 'spray-editor--setting',
};

export function storyForCaptureName(name: string): string {
  const key = name.replace(/\.png$/, '').replace(/^\d+-/, '');
  const story = VIEW_BY_NAME[key];
  if (!story) throw new Error(`No view story registered for capture ${name}`);
  return story;
}

/** Existing capture filenames remain the store/help contract; commands are story-only. */
export function readVisualStoryCaptures(flowFile: string): VisualStoryCapture[] {
  const source = readFileSync(flowFile, 'utf8');
  const captures = [...source.matchAll(/^\s*- takeScreenshot:\s*([\w-]+)\s*$/gm)].map((match) => ({
    name: match[1],
    storyId: storyForCaptureName(match[1]),
  }));
  if (!captures.length) throw new Error(`Visual flow has no captures: ${flowFile}`);
  if (new Set(captures.map(({ name }) => name)).size !== captures.length)
    throw new Error(`Duplicate capture filename in ${flowFile}`);
  return captures;
}

export function cppStoryCaptures(page: CppPage, device: 'phone' | 'ipad'): VisualStoryCapture[] {
  const target = (Object.keys(CPP_STORY_TARGETS) as CppStoryTarget[]).find(
    (candidate) => CPP_STORY_TARGETS[candidate].boardId === page.primaryBoard.id,
  );
  if (!target) throw new Error(`No CPP scene fixtures for ${page.primaryBoard.id}`);
  const names = [...new Set(page.recipes[device].flatMap((recipe) => recipe.sources))];
  return names.map((filename) => {
    const name = filename.replace(/\.png$/, '');
    if (name === '08-island')
      return { name, storyId: 'native-live-activity', nativeActivityBoard: page.primaryBoard.id };
    const board = /^(hero|other)-([123])$/.exec(name);
    if (board) {
      const variants = board[1] === 'hero' ? page.heroBoards : page.otherBoards;
      return { name, storyId: `player--${variants[Number(board[2]) - 1].id}` };
    }
    const scene = name.replace(/^\d+-/, '');
    if (!(CPP_STORY_SCENES[target] as readonly string[]).includes(scene))
      throw new Error(`No ${target} CPP story for ${name}`);
    return { name, storyId: `cpp-scenes--${target}-${scene}` };
  });
}
