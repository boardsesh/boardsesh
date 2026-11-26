// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchBarCommands } from 'react-native-screens';
import { useClimbsTabBarSearchField } from '../use-climbs-tab-bar-search-field';

type Options = Parameters<typeof useClimbsTabBarSearchField>[0];
type SearchBarOptions = NonNullable<ReturnType<typeof useClimbsTabBarSearchField>>;
type TextEvent = Parameters<NonNullable<SearchBarOptions['onChangeText']>>[0];
type CancelEvent = Parameters<NonNullable<SearchBarOptions['onCancelButtonPress']>>[0];

// One native field per test, shared across rerenders like the screen's ref.
let fieldRef: { current: SearchBarCommands | null } = { current: null };

function makeOptions(overrides: Partial<Options> = {}): Options {
  return {
    enabled: true,
    fieldRef,
    placeholder: 'Search climbs...',
    name: '',
    searchReady: true,
    readPendingName: () => overrides.name ?? '',
    onChangeText: vi.fn(),
    onSubmit: vi.fn(),
    onClear: vi.fn(),
    onFocus: vi.fn(),
    ...overrides,
  };
}

function makeField(): SearchBarCommands {
  return {
    focus: vi.fn(),
    blur: vi.fn(),
    clearText: vi.fn(),
    toggleCancelButton: vi.fn(),
    setText: vi.fn(),
    cancelSearch: vi.fn(),
  };
}

function textEvent(text: string): TextEvent {
  return { nativeEvent: { text } } as unknown as TextEvent;
}
const targetEvent = {} as unknown as CancelEvent;

function attach(options: ReturnType<typeof useClimbsTabBarSearchField>, field: SearchBarCommands) {
  // The native bar fills the ref it is handed, which must be the caller's own.
  expect(options?.ref).toBe(fieldRef);
  fieldRef.current = field;
}

describe('useClimbsTabBarSearchField', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fieldRef = { current: null };
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives no search bar when Climbs is an ordinary tab', () => {
    const { result } = renderHook(() => useClimbsTabBarSearchField(makeOptions({ enabled: false })));
    expect(result.current).toBeUndefined();
  });

  it('hands the bar a climb-name field that feeds the debounced name', () => {
    const onChangeText = vi.fn();
    const { result } = renderHook(() => useClimbsTabBarSearchField(makeOptions({ onChangeText })));

    expect(result.current).toMatchObject({
      placement: 'automatic',
      placeholder: 'Search climbs...',
      autoCapitalize: 'none',
      hideWhenScrolling: false,
    });
    result.current?.onChangeText?.(textEvent('crimp '));
    expect(onChangeText).toHaveBeenCalledWith('crimp ');
  });

  it('keeps the same options object across renders, so the header is not reset per keystroke', () => {
    const { result, rerender } = renderHook((options: Options) => useClimbsTabBarSearchField(options), {
      initialProps: makeOptions(),
    });
    const first = result.current;
    rerender(makeOptions({ name: 'crimp' }));
    expect(result.current).toBe(first);
  });

  it('writes a name set elsewhere (Filters, a recent filter, a board switch) into the field', () => {
    const field = makeField();
    const { result, rerender } = renderHook((options: Options) => useClimbsTabBarSearchField(options), {
      initialProps: makeOptions(),
    });
    attach(result.current, field);

    rerender(makeOptions({ name: 'Moonlight' }));

    expect(field.setText).toHaveBeenCalledWith('Moonlight');
  });

  it('leaves the field alone while the climber is typing a term of their own', () => {
    const field = makeField();
    const { result, rerender } = renderHook((options: Options) => useClimbsTabBarSearchField(options), {
      initialProps: makeOptions(),
    });
    attach(result.current, field);

    result.current?.onChangeText?.(textEvent('crimp '));
    // Committed: the trimmed text, which matches what the field shows.
    rerender(makeOptions({ name: 'crimp', readPendingName: () => 'crimp' }));
    // Still pending a longer term: an older committed name must not overwrite it.
    result.current?.onChangeText?.(textEvent('crimpy'));
    rerender(makeOptions({ name: 'crim', readPendingName: () => 'crimpy' }));

    expect(field.setText).not.toHaveBeenCalled();
  });

  it('waits for the native bar to attach before writing a restored name', () => {
    const field = makeField();
    const { result, rerender } = renderHook((options: Options) => useClimbsTabBarSearchField(options), {
      initialProps: makeOptions({ searchReady: false }),
    });

    rerender(makeOptions({ name: 'Moonlight' }));
    expect(field.setText).not.toHaveBeenCalled();
    attach(result.current, field);
    act(() => {
      vi.advanceTimersByTime(50);
    });

    expect(field.setText).toHaveBeenCalledWith('Moonlight');
  });

  it('empties the name on Cancel and commits on the Search key', () => {
    const field = makeField();
    const onClear = vi.fn();
    const onSubmit = vi.fn();
    const { result } = renderHook(() => useClimbsTabBarSearchField(makeOptions({ onClear, onSubmit })));
    attach(result.current, field);

    result.current?.onSearchButtonPress?.(textEvent('crimp'));
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(field.blur).toHaveBeenCalledOnce();

    result.current?.onCancelButtonPress?.(targetEvent);
    expect(onClear).toHaveBeenCalledOnce();
    expect(field.clearText).toHaveBeenCalledOnce();
  });
});
