import { describe, expect, it } from 'vitest';
import { buildStoryRegistry, findStory, moduleIdFromPath, toKebab } from '../registry-core';
import type { StoryModule } from '../types';

const render = () => null;

function storyModule(title: string, keys: string[]): StoryModule {
  return {
    title,
    stories: Object.fromEntries(keys.map((key) => [key, { name: key, render }])),
  };
}

describe('toKebab', () => {
  it('splits camelCase, PascalCase and acronyms', () => {
    expect(toKebab('crewFlagOn')).toBe('crew-flag-on');
    expect(toKebab('WallStatePill')).toBe('wall-state-pill');
    expect(toKebab('BLEStatus')).toBe('ble-status');
  });

  it('collapses punctuation and spaces into one dash', () => {
    expect(toKebab('  On the wall! ')).toBe('on-the-wall');
  });
});

describe('moduleIdFromPath', () => {
  it('drops the folders and the .stories suffix', () => {
    expect(moduleIdFromPath('./components/play-drawer/CrewBrowse.stories.tsx')).toBe('crew-browse');
    expect(moduleIdFromPath('wall-kiosk.stories.tsx')).toBe('wall-kiosk');
  });
});

describe('buildStoryRegistry', () => {
  it('ids every story as <module>--<story>, sorted', () => {
    const stories = buildStoryRegistry([
      { path: './b/Zebra.stories.tsx', module: storyModule('Zebra', ['stripes']) },
      { path: './a/CrewBrowse.stories.tsx', module: storyModule('Crew', ['pills', 'commitBar']) },
    ]);
    expect(stories.map((entry) => entry.id)).toEqual([
      'crew-browse--commit-bar',
      'crew-browse--pills',
      'zebra--stripes',
    ]);
    expect(stories[0]?.title).toBe('Crew');
  });

  it('refuses two stories with the same id and names both files', () => {
    expect(() =>
      buildStoryRegistry([
        { path: './a/CrewBrowse.stories.tsx', module: storyModule('A', ['pills']) },
        { path: './b/CrewBrowse.stories.tsx', module: storyModule('B', ['pills']) },
      ]),
    ).toThrow(/crew-browse--pills.*\.\/a\/CrewBrowse.*\.\/b\/CrewBrowse/);
  });
});

describe('findStory', () => {
  const stories = buildStoryRegistry([
    { path: './CrewBrowse.stories.tsx', module: storyModule('Crew', ['pills', 'commitBar']) },
  ]);

  it('finds an exact id', () => {
    expect(findStory(stories, 'crew-browse--pills')?.id).toBe('crew-browse--pills');
  });

  it('opens the first story of a bare module id', () => {
    expect(findStory(stories, 'crew-browse')?.id).toBe('crew-browse--commit-bar');
  });

  it('returns null for an unknown id', () => {
    expect(findStory(stories, 'nope')).toBeNull();
  });
});
