// @vitest-environment jsdom
import { createElement } from 'react';
import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import {
  isStartPromptCollapsed,
  localDayKey,
  recordStartPromptImpression,
  resetStartPromptImpressions,
  resetStartPromptStoreForTests,
  START_PROMPT_STORAGE_KEY,
  useStartPromptImpressions,
} from '../start-prompt-quiet-days';

async function getMockStorage() {
  return (await import('@react-native-async-storage/async-storage')).default as unknown as {
    __reset: () => void;
    __setRaw: (key: string, value: string) => void;
    __read: (key: string) => string | undefined;
  };
}

function Probe() {
  const { days, loaded } = useStartPromptImpressions();
  return createElement('span', { 'data-testid': 'probe' }, `${loaded ? 'loaded' : 'loading'}:${days.join(',')}`);
}

beforeEach(async () => {
  resetStartPromptStoreForTests();
  (await getMockStorage()).__reset();
});

describe('localDayKey', () => {
  it('uses the local calendar day, zero-padded', () => {
    expect(localDayKey(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
    expect(localDayKey(new Date(2026, 10, 30, 0, 1))).toBe('2026-11-30');
  });
});

describe('isStartPromptCollapsed', () => {
  it('collapses after three earlier ignored days', () => {
    expect(isStartPromptCollapsed(['2026-09-12', '2026-09-13'], '2026-09-16')).toBe(false);
    expect(isStartPromptCollapsed(['2026-09-12', '2026-09-13', '2026-09-14'], '2026-09-16')).toBe(true);
  });

  it('does not count today, so the tile never shrinks while being looked at', () => {
    expect(isStartPromptCollapsed(['2026-09-14', '2026-09-15', '2026-09-16'], '2026-09-16')).toBe(false);
  });
});

describe('impression store', () => {
  it('records one impression per day and persists it', async () => {
    recordStartPromptImpression('2026-09-14');
    recordStartPromptImpression('2026-09-14');
    recordStartPromptImpression('2026-09-15');
    const { getByTestId } = render(createElement(Probe));
    expect(getByTestId('probe').textContent).toBe('loaded:2026-09-14,2026-09-15');
    const storage = await getMockStorage();
    await waitFor(() => expect(storage.__read(START_PROMPT_STORAGE_KEY)).toBe('["2026-09-14","2026-09-15"]'));
  });

  it('loads stored days and resets them on a tap', async () => {
    const storage = await getMockStorage();
    storage.__setRaw(START_PROMPT_STORAGE_KEY, JSON.stringify(['2026-09-10', '2026-09-11', '2026-09-12']));
    const { getByTestId } = render(createElement(Probe));
    await waitFor(() => expect(getByTestId('probe').textContent).toBe('loaded:2026-09-10,2026-09-11,2026-09-12'));

    resetStartPromptImpressions();
    await waitFor(() => expect(getByTestId('probe').textContent).toBe('loaded:'));
    await waitFor(() => expect(storage.__read(START_PROMPT_STORAGE_KEY)).toBe('[]'));
  });

  it('ignores a corrupt stored value', async () => {
    const storage = await getMockStorage();
    storage.__setRaw(START_PROMPT_STORAGE_KEY, JSON.stringify({ nope: true }));
    const { getByTestId } = render(createElement(Probe));
    await waitFor(() => expect(getByTestId('probe').textContent).toBe('loaded:'));
  });

  it('keeps only the most recent week', () => {
    for (let day = 1; day <= 9; day += 1) recordStartPromptImpression(`2026-09-0${day}`);
    const { getByTestId } = render(createElement(Probe));
    expect(getByTestId('probe').textContent?.split(':')[1]?.split(',')).toHaveLength(7);
  });
});
