// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useState } from 'react';
import type { PlaceSuggestion } from '@boardsesh/shared-schema';
import { placeSuggestionLabel } from '@boardsesh/gym-filters';

const request = vi.hoisted(() => vi.fn());
const onSubmit = vi.hoisted(() => vi.fn());
const onSelect = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/graphql/client', () => ({ getHttpClient: () => ({ request }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { label: '#111', secondaryLabel: '#666', background: '#fff', separator: '#ccc' },
    brandColors: { primary: '#639' },
  }),
}));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12 },
  borderRadius: { lg: 12 },
}));
import { GymSearchField } from '../GymSearchField.web';

const ATLANTA: PlaceSuggestion = {
  id: 4180439,
  name: 'Atlanta',
  region: 'Georgia',
  country: 'United States',
  countryCode: 'US',
  latitude: 33.749,
  longitude: -84.388,
};

function SearchHarness() {
  const [text, setText] = useState('');
  const [hasSelectedPlace, setHasSelectedPlace] = useState(false);
  return (
    <GymSearchField
      text={text}
      hasSelectedPlace={hasSelectedPlace}
      isGeocoding={false}
      onChangeText={(next) => {
        setHasSelectedPlace(false);
        setText(next);
      }}
      onSelectPlace={(place) => {
        onSelect(place);
        setText(placeSuggestionLabel(place));
        setHasSelectedPlace(true);
      }}
      onSubmit={onSubmit}
      onClear={() => {
        setText('');
        setHasSelectedPlace(false);
      }}
    />
  );
}

async function lookupCity() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  request.mockResolvedValue({ searchPlaces: [ATLANTA] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('browser gym search', () => {
  it('debounces valid text and selects a city without submitting it as a gym name', async () => {
    const screen = render(<SearchHarness />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'At' } });
    await lookupCity();
    expect(request).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'Atl' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    fireEvent.change(input, { target: { value: ' Atlanta ' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(299);
    });
    expect(request).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toMatchObject({ variables: { query: 'Atlanta' } });
    fireEvent.click(screen.getByRole('option', { name: 'Atlanta, Georgia, United States' }));
    expect(onSelect).toHaveBeenCalledWith(ATLANTA);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(input).toHaveProperty('value', 'Atlanta, Georgia, United States');
    expect(screen.queryByRole('listbox')).toBeNull();
    await lookupCity();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('selects the highlighted suggestion with Enter and closes suggestions with Escape', async () => {
    const screen = render(<SearchHarness />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'Atlanta' } });
    await lookupCity();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    const option = screen.getByRole('option');
    expect(input.getAttribute('aria-activedescendant')).toBe(option.id);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.submit(screen.getByRole('search'));
    expect(onSelect).toHaveBeenCalledWith(ATLANTA);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits gym names without implicitly choosing a city', async () => {
    const screen = render(<SearchHarness />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Atlanta' } });
    await lookupCity();
    fireEvent.submit(screen.getByRole('search'));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.focus(screen.getByRole('combobox'));
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('button', { name: 'mobile.gyms.searchSubmit' }));
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('keeps gym-name search usable when city lookup fails or has no matches', async () => {
    request.mockRejectedValueOnce(new Error('offline'));
    const screen = render(<SearchHarness />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'atlanta bouldering' } });
    await lookupCity();
    expect(screen.getByRole('status').textContent).toBe('mobile.gyms.placesError');
    fireEvent.click(screen.getByRole('button', { name: 'mobile.gyms.searchSubmit' }));
    expect(onSubmit).toHaveBeenCalledOnce();
    request.mockResolvedValueOnce({ searchPlaces: [] });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Unknown city' } });
    await lookupCity();
    expect(screen.getByRole('status').textContent).toBe('mobile.gyms.placesEmpty');
  });

  it('aborts old lookups and cannot restore a cleared or replaced city', async () => {
    let finishOld!: (response: { searchPlaces: PlaceSuggestion[] }) => void;
    request.mockReturnValueOnce(
      new Promise((resolve) => {
        finishOld = resolve;
      }),
    );
    const screen = render(<SearchHarness />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Atlanta' } });
    await lookupCity();
    const signal = request.mock.calls[0][0].signal as AbortSignal;
    fireEvent.click(screen.getByRole('button', { name: 'mobile.gyms.clearSearch' }));
    expect(signal.aborted).toBe(true);
    await act(async () => {
      finishOld({ searchPlaces: [ATLANTA] });
    });
    expect(screen.getByRole('combobox')).toHaveProperty('value', '');
    expect(screen.queryByRole('option')).toBeNull();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'a'.repeat(81) } });
    await lookupCity();
    expect(request).toHaveBeenCalledOnce();
  });

  it('cancels an outstanding city request when unmounted', async () => {
    request.mockReturnValue(new Promise(() => {}));
    const screen = render(<SearchHarness />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'Atlanta' } });
    await lookupCity();
    const signal = request.mock.calls[0][0].signal as AbortSignal;
    screen.unmount();
    expect(signal.aborted).toBe(true);
  });
});

describe('browser gym search, towns listed by the screen', () => {
  function InlineHarness({ onSuggestions }: { onSuggestions: (places: readonly PlaceSuggestion[]) => void }) {
    const [text, setText] = useState('');
    const [hasSelectedPlace, setHasSelectedPlace] = useState(false);
    return (
      <GymSearchField
        text={text}
        hasSelectedPlace={hasSelectedPlace}
        isGeocoding={false}
        onChangeText={(next) => {
          setHasSelectedPlace(false);
          setText(next);
        }}
        onSelectPlace={(place) => {
          onSelect(place);
          setText(placeSuggestionLabel(place));
          setHasSelectedPlace(true);
        }}
        onSubmit={onSubmit}
        onClear={vi.fn()}
        suggestionsPlacement="inline"
        onSuggestionsChange={onSuggestions}
      />
    );
  }

  it('draws no listbox, hands the towns over, and keeps them when focus leaves for a row', async () => {
    const onSuggestions = vi.fn();
    const screen = render(<InlineHarness onSuggestions={onSuggestions} />);
    const input = screen.getByRole('searchbox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'atlanta' } });
    await lookupCity();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(onSuggestions).toHaveBeenLastCalledWith([ATLANTA]);
    // A click on a town in the list blurs the field before it lands.
    fireEvent.blur(input);
    expect(onSuggestions).toHaveBeenLastCalledWith([ATLANTA]);
    // Enter is a gym-name search, never a hidden town pick.
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSuggestions).toHaveBeenLastCalledWith([]);
  });
});
