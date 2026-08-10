// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { loadSectionExpandState, resetSectionExpandStoreForTests } from '../../lib/section-expand-store';

// AsyncStorage holds the persisted expand map. Seed it before rendering to drive
// the cold-load path (store unloaded at first mount, value arrives async).
vi.mock('@react-native-async-storage/async-storage', () => {
  let storage: Record<string, string> = {};
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage[key] ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        storage[key] = value;
      }),
      removeItem: vi.fn(async (key: string) => {
        delete storage[key];
      }),
      __reset: () => {
        storage = {};
      },
      __setRaw: (key: string, value: string) => {
        storage[key] = value;
      },
    },
  };
});

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
    createElement('button', { onClick: () => onPress?.() }, children),
  StyleSheet: { create: (styles: unknown) => styles },
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: ({ children }: { children?: ReactNode }) => createElement('div', null, children) },
  useSharedValue: (value: number) => ({ value }),
  useAnimatedStyle: (factory: () => Record<string, unknown>) => factory(),
  withTiming: (value: number) => value,
}));
vi.mock('../Text', () => ({ Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children) }));
vi.mock('../Icon', () => ({ Icon: () => createElement('i', null) }));
vi.mock('../../lib/haptics', () => ({ hapticSelection: vi.fn() }));

const BODY = 'SECTION_BODY';

async function getMockStorage() {
  return (await import('@react-native-async-storage/async-storage')).default as unknown as {
    __reset: () => void;
    __setRaw: (key: string, value: string) => void;
  };
}

async function seedStorage(key: string, value: boolean) {
  (await getMockStorage()).__setRaw('climbCardSectionExpanded', JSON.stringify({ [key]: value }));
}

import { CollapsibleSection } from '../CollapsibleSection';

describe('CollapsibleSection persistence', () => {
  // Each test owns its store + storage state — no inherited side-effects, so the
  // file is order-independent and passes in isolation.
  beforeEach(async () => {
    resetSectionExpandStoreForTests();
    (await getMockStorage()).__reset();
  });

  it('reconciles to the persisted expanded state once the cold store loads', async () => {
    // Cold store: seed AsyncStorage, render collapsed, then the async load should
    // flip the section open via the persisted-sync effect.
    await seedStorage('logbook', true);
    const { queryByText, getByText } = render(
      createElement(CollapsibleSection, {
        title: 'Logbook',
        persistKey: 'logbook',
        defaultExpanded: false,
        children: createElement('span', null, BODY),
      }),
    );

    // Cold store → seeded from default (collapsed) → body not rendered yet.
    expect(queryByText(BODY)).toBeNull();
    // After the async load resolves, the effect expands the section.
    await waitFor(() => expect(getByText(BODY)).toBeTruthy());
  });

  it('seeds the initial state synchronously when the store is already warm', async () => {
    // Warm the store before rendering: the mount then reads the value
    // synchronously and opens with no async wait.
    await seedStorage('logbook', true);
    await loadSectionExpandState();

    const { getByText } = render(
      createElement(CollapsibleSection, {
        title: 'Logbook',
        persistKey: 'logbook',
        defaultExpanded: false,
        children: createElement('span', null, BODY),
      }),
    );
    expect(getByText(BODY)).toBeTruthy();
  });

  it('fires onToggle only on a user tap, with the next expanded state', () => {
    // This is the signal the play drawer keys its scroll-into-view off, so it
    // must fire on the tap (and NOT on mount / persisted reconciliation).
    const onToggle = vi.fn();
    const { getAllByRole } = render(
      createElement(CollapsibleSection, {
        title: 'Logbook',
        defaultExpanded: false,
        onToggle,
        children: createElement('span', null, BODY),
      }),
    );

    // Two toggle targets: the title cluster and the chevron (the header action,
    // when present, sits between them and owns its own taps).
    const title = () => getAllByRole('button')[0];
    expect(onToggle).not.toHaveBeenCalled();
    fireEvent.click(title());
    expect(onToggle).toHaveBeenLastCalledWith(true);
    fireEvent.click(title());
    expect(onToggle).toHaveBeenLastCalledWith(false);
  });
});

describe('CollapsibleSection body rendering', () => {
  beforeEach(async () => {
    resetSectionExpandStoreForTests();
    (await getMockStorage()).__reset();
  });

  // Guards the mount/unmount contract of the expanded body. NOTE: Vitest mocks
  // react-native-reanimated (the `entering` prop is ignored) and .ios.tsx files
  // resolve to stubs, so this cannot reproduce the native iOS FadeIn-blank bug
  // this change fixes — that is verified on-device. It does pin that the body
  // renders when expanded and unmounts when collapsed.
  it('renders the body only while expanded, toggling on header tap', () => {
    const { getAllByRole, queryByText } = render(
      createElement(CollapsibleSection, {
        title: 'Logbook',
        defaultExpanded: false,
        children: createElement('span', null, BODY),
      }),
    );

    const title = () => getAllByRole('button')[0];
    // Collapsed by default → body absent.
    expect(queryByText(BODY)).toBeNull();
    // Tap to expand → body present (plain View, no FadeIn gate).
    fireEvent.click(title());
    expect(queryByText(BODY)).toBeTruthy();
    // Tap again to collapse → body removed.
    fireEvent.click(title());
    expect(queryByText(BODY)).toBeNull();
  });

  it('toggles from the chevron as well as the title', () => {
    const { getAllByRole, queryByText } = render(
      createElement(CollapsibleSection, {
        title: 'Logbook',
        defaultExpanded: false,
        children: createElement('span', null, BODY),
      }),
    );

    fireEvent.click(getAllByRole('button')[1]);
    expect(queryByText(BODY)).toBeTruthy();
  });

  it('lets a headerAction press through without folding the section', () => {
    // The Beta Videos "+" lives in this slot. It must add a video, not collapse
    // the section out from under the user (#4229).
    const onActionPress = vi.fn();
    // Anchored by its own label rather than a positional index, so restructuring
    // the header can't silently retarget this at the wrong button.
    const { getByText, queryByText } = render(
      createElement(CollapsibleSection, {
        title: 'Beta Videos',
        defaultExpanded: true,
        headerAction: createElement('button', { onClick: onActionPress }, 'ADD_BETA'),
        children: createElement('span', null, BODY),
      }),
    );

    expect(queryByText(BODY)).toBeTruthy();
    fireEvent.click(getByText('ADD_BETA'));
    expect(onActionPress).toHaveBeenCalledTimes(1);
    expect(queryByText(BODY)).toBeTruthy();
  });
});
