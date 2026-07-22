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
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
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
    const { getByRole } = render(
      createElement(CollapsibleSection, {
        title: 'Logbook',
        defaultExpanded: false,
        onToggle,
        children: createElement('span', null, BODY),
      }),
    );

    expect(onToggle).not.toHaveBeenCalled();
    fireEvent.click(getByRole('button'));
    expect(onToggle).toHaveBeenLastCalledWith(true);
    fireEvent.click(getByRole('button'));
    expect(onToggle).toHaveBeenLastCalledWith(false);
  });
});
