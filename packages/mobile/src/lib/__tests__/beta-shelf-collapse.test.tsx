// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, fireEvent, act } from '@testing-library/react';
import { createElement } from 'react';

// AsyncStorage backs the shared expand map. Same in-memory double the
// CollapsibleSection persistence test uses, so both exercise the real store.
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
      __read: (key: string) => storage[key],
    },
  };
});
vi.mock('../haptics', () => ({ hapticSelection: vi.fn() }));

import { BETA_SHELF_SECTION_KEY, BETA_SHELF_DEFAULT_EXPANDED, useBetaShelfCollapse } from '../beta-shelf-collapse';
import { resetSectionExpandStoreForTests, setSectionExpanded, STORAGE_KEY } from '../section-expand-store';

async function getMockStorage() {
  return (await import('@react-native-async-storage/async-storage')).default as unknown as {
    __reset: () => void;
    __setRaw: (key: string, value: string) => void;
    __read: (key: string) => string | undefined;
  };
}

// Stands in for any of the four shelves: renders its expand state and a header
// tap target, exactly like the real surfaces do.
function Shelf({ name }: { name: string }) {
  const { expanded, toggle } = useBetaShelfCollapse();
  return createElement(
    'div',
    null,
    createElement('button', { onClick: toggle }, `toggle-${name}`),
    createElement('span', null, `${name}:${expanded ? 'expanded' : 'collapsed'}`),
  );
}

describe('useBetaShelfCollapse', () => {
  beforeEach(async () => {
    resetSectionExpandStoreForTests();
    (await getMockStorage()).__reset();
  });

  it('defaults to expanded so the shelf is never hidden from existing users', () => {
    expect(BETA_SHELF_DEFAULT_EXPANDED).toBe(true);
    const { getByText } = render(createElement(Shelf, { name: 'home' }));
    expect(getByText('home:expanded')).toBeTruthy();
  });

  it('collapses on toggle and persists under the shared section key', async () => {
    const { getByText } = render(createElement(Shelf, { name: 'home' }));

    fireEvent.click(getByText('toggle-home'));
    expect(getByText('home:collapsed')).toBeTruthy();

    const storage = await getMockStorage();
    await waitFor(() => {
      expect(JSON.parse(storage.__read(STORAGE_KEY) ?? '{}')).toMatchObject({
        [BETA_SHELF_SECTION_KEY]: false,
      });
    });
  });

  it('shares one state across every surface — collapsing on one folds them all', () => {
    // The core promise of #4229: "collapsible anywhere it shows" means one
    // preference, not four. Mount two shelves and toggle only the first.
    const { getByText } = render(
      createElement('div', null, createElement(Shelf, { name: 'home' }), createElement(Shelf, { name: 'profile' })),
    );

    expect(getByText('home:expanded')).toBeTruthy();
    expect(getByText('profile:expanded')).toBeTruthy();

    fireEvent.click(getByText('toggle-home'));

    expect(getByText('home:collapsed')).toBeTruthy();
    expect(getByText('profile:collapsed')).toBeTruthy();
  });

  it('picks up an external write to the same key (e.g. the play-drawer section)', () => {
    // The play drawer collapses through CollapsibleSection's own persistKey
    // rather than this hook, so a write from there must reach the shelves.
    const { getByText } = render(createElement(Shelf, { name: 'home' }));
    expect(getByText('home:expanded')).toBeTruthy();

    act(() => {
      setSectionExpanded(BETA_SHELF_SECTION_KEY, false);
    });

    expect(getByText('home:collapsed')).toBeTruthy();
  });

  it('reconciles to a collapsed value stored before launch', async () => {
    // Cold store: the value arrives from AsyncStorage after first paint.
    (await getMockStorage()).__setRaw(STORAGE_KEY, JSON.stringify({ [BETA_SHELF_SECTION_KEY]: false }));

    const { getByText } = render(createElement(Shelf, { name: 'home' }));

    await waitFor(() => expect(getByText('home:collapsed')).toBeTruthy());
  });
});
