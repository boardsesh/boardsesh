// @vitest-environment jsdom
//
// The native gym search suggests towns as the climber types, like the browser
// field, so "search a town" works with location off.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { createElement, useState, type ReactNode } from 'react';
import type { PlaceSuggestion } from '@boardsesh/shared-schema';
import { placeSuggestionLabel } from '@boardsesh/gym-filters';

type Children = { children?: ReactNode; testID?: string };

const request = vi.hoisted(() => vi.fn());
const onSelect = vi.hoisted(() => vi.fn());
const onFocusChange = vi.hoisted(() => vi.fn());
vi.mock('react-native', () => ({
  View: ({ children, testID }: Children) => createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));
vi.mock('../../../lib/graphql/client', () => ({ getHttpClient: () => ({ request }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ systemColors: {} }) }));
vi.mock('../../../hooks/use-typography-styles', () => ({
  useTypographyStyles: (create: (scale: { callout: { fontSize: number } }) => unknown) =>
    create({ callout: { fontSize: 16 } }),
}));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12 },
  borderRadius: { lg: 12 },
  shadows: { md: {} },
}));
vi.mock('../../AccessibleTextInput', () => ({
  AccessibleTextInput: ({
    value,
    onChangeText,
    onFocus,
    onBlur,
    onSubmitEditing,
    selectTextOnFocus,
  }: {
    value: string;
    onChangeText: (text: string) => void;
    onFocus: () => void;
    onBlur: () => void;
    onSubmitEditing: () => void;
    selectTextOnFocus?: boolean;
  }) =>
    createElement('input', {
      value,
      'data-testid': 'gym-search-input',
      'data-select-on-focus': String(Boolean(selectTextOnFocus)),
      onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
      onFocus,
      onBlur,
      onKeyDown: (event: { key: string }) => {
        if (event.key === 'Enter') onSubmitEditing();
      },
    }),
}));
vi.mock('../../ActivityIndicator', () => ({ ActivityIndicator: () => null }));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../Text', () => ({ Text: ({ children }: Children) => createElement('span', null, children) }));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children, onPress, testID }: Children & { onPress?: () => void }) =>
    createElement('button', { type: 'button', onClick: onPress, 'data-testid': testID }, children),
}));

import { GymSearchField } from '../GymSearchField';

const AMSTERDAM: PlaceSuggestion = {
  id: 2759794,
  name: 'Amsterdam',
  region: 'North Holland',
  country: 'Netherlands',
  countryCode: 'NL',
  latitude: 52.374,
  longitude: 4.8897,
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
      onSubmit={vi.fn()}
      onClear={vi.fn()}
      onFocusChange={onFocusChange}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  request.mockResolvedValue({ searchPlaces: [AMSTERDAM] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function typeTown(screen: ReturnType<typeof render>) {
  fireEvent.focus(screen.getByTestId('gym-search-input'));
  fireEvent.change(screen.getByTestId('gym-search-input'), { target: { value: 'amster' } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
}

describe('native gym search', () => {
  it('suggests towns once the text has been still, and hands the picked one over', async () => {
    const screen = render(<SearchHarness />);
    fireEvent.focus(screen.getByTestId('gym-search-input'));
    expect(onFocusChange).toHaveBeenLastCalledWith(true);
    fireEvent.change(screen.getByTestId('gym-search-input'), { target: { value: 'amster' } });
    expect(request).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ variables: { query: 'amster' } }));

    fireEvent.click(screen.getByTestId(`gym-search-place-${AMSTERDAM.id}`));
    expect(onSelect).toHaveBeenCalledWith(AMSTERDAM);
    // A chosen town is not looked up again, and its suggestions close.
    expect(screen.queryByTestId('gym-search-places')).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(request).toHaveBeenCalledOnce();
    // Focusing the picked town selects its label, so typing replaces it.
    expect(screen.getByTestId('gym-search-input').getAttribute('data-select-on-focus')).toBe('true');
  });

  it('hides the towns when the field loses focus, and shows them again on focus', async () => {
    const screen = render(<SearchHarness />);
    await typeTown(screen);
    expect(screen.getByTestId('gym-search-places')).toBeTruthy();
    fireEvent.blur(screen.getByTestId('gym-search-input'));
    expect(onFocusChange).toHaveBeenLastCalledWith(false);
    expect(screen.queryByTestId('gym-search-places')).toBeNull();
    fireEvent.focus(screen.getByTestId('gym-search-input'));
    expect(screen.getByTestId('gym-search-places')).toBeTruthy();
  });

  it('closes the towns on submit until the text changes', async () => {
    const screen = render(<SearchHarness />);
    await typeTown(screen);
    fireEvent.keyDown(screen.getByTestId('gym-search-input'), { key: 'Enter' });
    expect(screen.queryByTestId('gym-search-places')).toBeNull();
    fireEvent.change(screen.getByTestId('gym-search-input'), { target: { value: 'amste' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(screen.getByTestId('gym-search-places')).toBeTruthy();
  });

  it('does not look up fewer than three characters', async () => {
    const screen = render(<SearchHarness />);
    fireEvent.change(screen.getByTestId('gym-search-input'), { target: { value: 'am' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(request).not.toHaveBeenCalled();
    expect(screen.queryByTestId('gym-search-places')).toBeNull();
  });
});

describe('native gym search, towns listed by the screen', () => {
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
        onSubmit={vi.fn()}
        onClear={vi.fn()}
        suggestionsPlacement="inline"
        onSuggestionsChange={onSuggestions}
      />
    );
  }

  it('floats nothing and hands the towns over, keeping them through a blur', async () => {
    const onSuggestions = vi.fn();
    const screen = render(<InlineHarness onSuggestions={onSuggestions} />);
    await typeTown(screen);
    expect(screen.queryByTestId('gym-search-places')).toBeNull();
    expect(onSuggestions).toHaveBeenLastCalledWith([AMSTERDAM]);
    // A drag of the list closes the keyboard; the towns stay listed so the tap lands.
    fireEvent.blur(screen.getByTestId('gym-search-input'));
    expect(onSuggestions).toHaveBeenLastCalledWith([AMSTERDAM]);
  });

  it('hands over none once the search is submitted', async () => {
    const onSuggestions = vi.fn();
    const screen = render(<InlineHarness onSuggestions={onSuggestions} />);
    await typeTown(screen);
    fireEvent.keyDown(screen.getByTestId('gym-search-input'), { key: 'Enter' });
    expect(onSuggestions).toHaveBeenLastCalledWith([]);
  });
});
