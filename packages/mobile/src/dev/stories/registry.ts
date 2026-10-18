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

// `vp run check:mobile-bundle` fails if this string is in a production export:
// it means the registry, and with it every story file, escaped the `__DEV__`
// gate in load.ts. The log is deliberately not behind `__DEV__` itself, or a
// minifier could drop the string from a leaked registry and the check would
// pass. This file only ever runs in a dev bundle.
const STORY_REGISTRY_MARKER = '[stories] registry';
// eslint-disable-next-line no-console
console.log(`${STORY_REGISTRY_MARKER} ${STORIES.length} stories`);
