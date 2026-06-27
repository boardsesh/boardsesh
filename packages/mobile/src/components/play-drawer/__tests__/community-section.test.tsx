// @vitest-environment jsdom
import { createElement, useSyncExternalStore, type ReactNode } from 'react';
import { render, screen, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AscentCountSource } from '../../../lib/ascent-count-source';

type PreferenceSnapshot = { source: AscentCountSource; loaded: boolean };

// A tiny external store standing in for the real AsyncStorage-backed preference
// hook (which also drives re-renders via useSyncExternalStore). Mutating it from
// a test re-renders the component even though it's memo()'d — memo only blocks
// parent-prop re-renders, not a component's own store/state change.
const preferenceStore = vi.hoisted(() => {
  let snapshot: PreferenceSnapshot = { source: 'all', loaded: false };
  const listeners = new Set<() => void>();
  const get = (): PreferenceSnapshot => snapshot;
  const set = (next: PreferenceSnapshot): void => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  return { get, set, subscribe };
});

// Captured onSelect from the (mocked) SegmentedControl so a test can simulate the
// user picking a chart source.
const segmented = vi.hoisted(() => ({
  onSelect: null as ((key: AscentCountSource) => void) | null,
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (options: { ios?: unknown; default?: unknown }) => options.ios ?? options.default },
  PlatformColor: (name: string) => name,
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../DifficultyByAngleChart', () => ({
  DifficultyByAngleChart: () => createElement('div', { 'data-testid': 'chart' }),
}));
vi.mock('../../SegmentedControl', () => ({
  SegmentedControl: ({
    selectedKey,
    onSelect,
  }: {
    selectedKey: AscentCountSource;
    onSelect: (key: AscentCountSource) => void;
  }) => {
    segmented.onSelect = onSelect;
    return createElement('div', { 'data-testid': 'segmented', 'data-selected': selectedKey });
  },
}));
vi.mock('../../../hooks/use-grade-format', () => ({ useGradeFormat: () => ({ gradeFormat: 'v-grade' }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { fill: '#eee', secondaryLabel: '#999' } }),
}));
vi.mock('../../../lib/format-climb-stats', () => ({ formatQuality: (quality: string) => quality }));
vi.mock('../../../lib/ascent-count-source-preference', () => ({
  useAscentCountSource: () => useSyncExternalStore(preferenceStore.subscribe, preferenceStore.get, preferenceStore.get),
}));

// Mutable angle-stats holder so a test can swap the dataset (e.g. a single-source
// climb) before rendering. Defaults to one angle with BOTH a board-app split
// (kilter/aurora) and Boardsesh sends, so the source toggle renders (needs >1
// non-zero source) and nothing is disabled.
const statsStore = vi.hoisted(() => {
  const twoSource = [
    {
      angle: 40,
      ascensionistCount: 10,
      kilterAscensionistCount: 6,
      auroraAscensionistCount: 4,
      boardseshAscensionistCount: 3,
      qualityAverage: 2.5,
      difficultyAverage: 20,
      displayDifficulty: 20,
      difficulty: '20',
      faUsername: null,
      faAt: null,
    },
  ];
  let data: unknown = twoSource;
  return {
    twoSource,
    get: (): unknown => data,
    set: (next: unknown): void => {
      data = next;
    },
  };
});
vi.mock('../../../lib/graphql/hooks', () => ({ useClimbStatsForAngles: () => ({ data: statsStore.get() }) }));

import { CommunitySection } from '../CommunitySection';

const element = (
  <CommunitySection
    climbUuid="climb-1"
    boardName="kilter"
    qualityAverage="2.5"
    ascensionistCount={10}
    kilterAscensionistCount={6}
    auroraAscensionistCount={4}
    boardseshAscensionistCount={3}
  />
);

function selectedSource(): string | null {
  return screen.getByTestId('segmented').getAttribute('data-selected');
}

describe('CommunitySection chart source seeding', () => {
  beforeEach(() => {
    preferenceStore.set({ source: 'all', loaded: false });
    statsStore.set(statsStore.twoSource);
    segmented.onSelect = null;
  });

  it('re-seeds the chart source from the preference once it loads', () => {
    render(element);
    // Before AsyncStorage resolves, the preference reads as the "all" default.
    expect(selectedSource()).toBe('all');

    act(() => preferenceStore.set({ source: 'boardApp', loaded: true }));

    expect(selectedSource()).toBe('boardApp');
  });

  it('stops following the preference once the user picks a chart source', () => {
    act(() => preferenceStore.set({ source: 'all', loaded: true }));
    render(element);
    expect(selectedSource()).toBe('all');

    act(() => segmented.onSelect?.('boardsesh'));
    expect(selectedSource()).toBe('boardsesh');

    // A later global-preference change must NOT clobber the local override.
    act(() => preferenceStore.set({ source: 'boardApp', loaded: true }));

    expect(selectedSource()).toBe('boardsesh');
  });

  it('suppresses the source toggle when only one source has data', () => {
    // Board-app-only climb: kilter/aurora sends but zero Boardsesh ticks, so just
    // one source is non-zero — the toggle would be redundant with the headline.
    statsStore.set([
      {
        angle: 40,
        ascensionistCount: 6,
        kilterAscensionistCount: 6,
        auroraAscensionistCount: 4,
        boardseshAscensionistCount: 0,
        qualityAverage: 2.5,
        difficultyAverage: 20,
        displayDifficulty: 20,
        difficulty: '20',
        faUsername: null,
        faAt: null,
      },
    ]);
    act(() => preferenceStore.set({ source: 'all', loaded: true }));
    render(
      <CommunitySection
        climbUuid="climb-2"
        boardName="kilter"
        qualityAverage="2.5"
        ascensionistCount={6}
        kilterAscensionistCount={6}
        auroraAscensionistCount={4}
        boardseshAscensionistCount={0}
      />,
    );

    // No toggle, but the chart for that single source still renders.
    expect(screen.queryByTestId('segmented')).toBeNull();
    expect(screen.getByTestId('chart')).not.toBeNull();
  });
});
