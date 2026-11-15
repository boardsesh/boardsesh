import { buildStoryRegistry, findStory, moduleIdFromPath } from './registry-core';
import type { RegisteredStory, StoryModule } from './types';

// Discover paths without evaluating every story's imports on a deep link.
type StoryFiles = { keys(): string[]; (path: string): unknown };
const storyFiles = (
  require as unknown as { context(directory: string, recursive: boolean, filter: RegExp): StoryFiles }
).context('../..', true, /\.stories\.tsx$/);

function registryForPaths(paths: readonly string[]): RegisteredStory[] {
  return buildStoryRegistry(
    paths.map((path) => ({
      path,
      module: (storyFiles(path) as { default: StoryModule }).default,
    })),
  );
}

export function loadStory(id: string): RegisteredStory | null {
  const moduleId = id.split('--')[0];
  return findStory(registryForPaths(storyFiles.keys().filter((path) => moduleIdFromPath(path) === moduleId)), id);
}

export function loadStories(): RegisteredStory[] {
  return registryForPaths(storyFiles.keys());
}

export function storyModuleIds(): string[] {
  return storyFiles.keys().map(moduleIdFromPath).sort();
}

// Bundle exclusion checks deliberately look for this unguarded marker.
// eslint-disable-next-line no-console
console.log(`[stories] registry ${storyFiles.keys().length} modules`);
