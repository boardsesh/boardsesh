import { buildStoryRegistry } from './registry-core';
import type { StoryModule } from './types';

// Every `*.stories.tsx` under packages/mobile/src, found by Metro at bundle time
// (expo-router's Metro config enables require.context). Reached only through
// `load.ts`, which keeps this file out of production bundles.
// The `as` is erased at build time, so Metro still sees a literal `require.context`.
type StoryFiles = { keys(): string[]; (path: string): unknown };
const storyFiles = (
  require as unknown as { context(directory: string, recursive: boolean, filter: RegExp): StoryFiles }
).context('../..', true, /\.stories\.tsx$/);

export const STORIES = buildStoryRegistry(
  storyFiles.keys().map((path: string) => ({
    path,
    module: (storyFiles(path) as { default: StoryModule }).default,
  })),
);
