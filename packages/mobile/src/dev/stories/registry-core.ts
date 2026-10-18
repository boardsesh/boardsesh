import type { RegisteredStory, StoryModule } from './types';

/** `WallState` → `wall-state`, `crewBrowse` → `crew-browse`, `On wall!` → `on-wall`. */
export function toKebab(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

/** `./components/play-drawer/WallState.stories.tsx` → `wall-state`. */
export function moduleIdFromPath(path: string): string {
  const file = path.split('/').pop() ?? path;
  return toKebab(file.replace(/\.stories\.tsx?$/, ''));
}

/**
 * Flatten the discovered story files into one list with stable ids. Two stories
 * with the same id would make a deep link ambiguous, so that throws, naming both
 * files.
 */
export function buildStoryRegistry(entries: readonly { path: string; module: StoryModule }[]): RegisteredStory[] {
  const firstPathById = new Map<string, string>();
  const stories: RegisteredStory[] = [];
  for (const { path, module } of entries) {
    const moduleId = moduleIdFromPath(path);
    for (const [key, story] of Object.entries(module.stories)) {
      const id = `${moduleId}--${toKebab(key)}`;
      const firstPath = firstPathById.get(id);
      if (firstPath !== undefined) {
        throw new Error(`Story id "${id}" is defined twice: ${firstPath} and ${path}`);
      }
      firstPathById.set(id, path);
      stories.push({ id, moduleId, title: module.title, story });
    }
  }
  return stories.sort((left, right) => left.id.localeCompare(right.id));
}

/** An exact story id, or a bare module id, which opens that file's first story. */
export function findStory(stories: readonly RegisteredStory[], id: string): RegisteredStory | null {
  return stories.find((entry) => entry.id === id) ?? stories.find((entry) => entry.moduleId === id) ?? null;
}
