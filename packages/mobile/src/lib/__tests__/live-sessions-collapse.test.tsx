// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, fireEvent, act } from '@testing-library/react';
import { createElement } from 'react';

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

import { LIVE_SESSIONS_SECTION_KEY, useLiveSessionsCollapse } from '../live-sessions-collapse';
import { BETA_SHELF_SECTION_KEY } from '../beta-shelf-collapse';
import { resetSectionExpandStoreForTests, STORAGE_KEY } from '../section-expand-store';

async function getMockStorage() {
  return (await import('@react-native-async-storage/async-storage')).default as unknown as {
    __reset: () => void;
    __setRaw: (key: string, value: string) => void;
    __read: (key: string) => string | undefined;
  };
}

function Rail() {
  const { expanded, toggle, loaded } = useLiveSessionsCollapse();
  return createElement(
    'div',
    null,
    createElement('button', { onClick: toggle }, 'toggle'),
    createElement(
      'span',
      { 'data-testid': 'state' },
      `${loaded ? 'loaded' : 'loading'}:${expanded ? 'open' : 'closed'}`,
    ),
  );
}

describe('useLiveSessionsCollapse', () => {
  beforeEach(async () => {
    resetSectionExpandStoreForTests();
    (await getMockStorage()).__reset();
  });

  it('defaults to expanded once the store has loaded', async () => {
    const { getByTestId } = render(createElement(Rail));
    await waitFor(() => expect(getByTestId('state').textContent).toBe('loaded:open'));
  });

  it('persists a collapse under its own key, separate from the beta shelves', async () => {
    const storage = await getMockStorage();
    storage.__setRaw(STORAGE_KEY, JSON.stringify({ [BETA_SHELF_SECTION_KEY]: false }));
    const { getByTestId, getByText } = render(createElement(Rail));
    await waitFor(() => expect(getByTestId('state').textContent).toBe('loaded:open'));

    act(() => {
      fireEvent.click(getByText('toggle'));
    });
    expect(getByTestId('state').textContent).toBe('loaded:closed');
    await waitFor(() =>
      expect(JSON.parse(storage.__read(STORAGE_KEY) ?? '{}')).toEqual({
        [BETA_SHELF_SECTION_KEY]: false,
        [LIVE_SESSIONS_SECTION_KEY]: false,
      }),
    );
  });
});
