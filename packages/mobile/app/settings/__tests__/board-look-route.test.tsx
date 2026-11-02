// @vitest-environment jsdom
//
// The Board page's route reads `?section=lighting`: the player's preview-first
// card sends a climber there for the keep-lighting choice, so the page opens on
// its lighting group (`BoardLookScreen`'s `leadWithLighting`).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';

const route = vi.hoisted(() => ({
  params: {} as Record<string, string>,
  screens: [] as { leadWithLighting?: boolean }[],
}));
vi.mock('expo-router', () => ({ useLocalSearchParams: () => route.params }));
vi.mock('../../../src/components/settings/board-look/BoardLookScreen', () => ({
  BoardLookScreen: (props: { leadWithLighting?: boolean }) => {
    route.screens.push(props);
    return null;
  },
}));

const { default: BoardLookRoute } = await import('../board-look/index');

afterEach(() => {
  cleanup();
  route.params = {};
  route.screens = [];
});

describe('the Board settings route', () => {
  it('opens on the lighting group when sent for it', () => {
    route.params = { section: 'lighting' };
    render(createElement(BoardLookRoute));
    expect(route.screens.at(-1)?.leadWithLighting).toBe(true);
  });

  it('opens on the looks otherwise', () => {
    render(createElement(BoardLookRoute));
    expect(route.screens.at(-1)?.leadWithLighting).toBe(false);
    cleanup();

    route.params = { section: 'something-else' };
    render(createElement(BoardLookRoute));
    expect(route.screens.at(-1)?.leadWithLighting).toBe(false);
  });
});
