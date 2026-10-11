import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TutorialPlatform } from './types';

export const TUTORIAL_REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const TUTORIAL_WORK_ROOT = resolve(TUTORIAL_REPO_ROOT, '.boardsesh/tutorial-videos');
export const tutorialTakeDir = (workRoot: string, platform: TutorialPlatform, takeId: string): string =>
  resolve(workRoot, 'work', platform, 'takes', takeId);
export const tutorialOutputDir = (workRoot: string, platform: TutorialPlatform, episodeId: string): string =>
  resolve(workRoot, 'out', platform, episodeId);
export const tutorialAudioDir = (workRoot: string, episodeId: string): string => resolve(workRoot, 'audio', episodeId);
