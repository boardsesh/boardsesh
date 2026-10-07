// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { isValidElement, type ReactElement } from 'react';

const cfg = vi.hoisted(() => ({ navigation: { setOptions: vi.fn() } }));
vi.mock('expo-router', () => ({ useNavigation: () => cfg.navigation }));

// The buttons themselves are SheetTopBar's twins and are not under test here;
// stand-ins keep this test off the native tree.
vi.mock('../../components/HeaderActionButtons', () => ({
  HeaderLeadingButton: () => null,
  HeaderTrailingButton: () => null,
}));

import { useHeaderActions } from '../use-header-actions';

type SlotRenderer = (props: { tintColor?: string }) => ReactElement;
type Options = { headerLeft?: SlotRenderer; headerRight?: SlotRenderer };

const optionCalls = (): Options[] => cfg.navigation.setOptions.mock.calls.map(([options]) => options as Options);
/** The onPress a rendered header element was handed; fails the test if there is no element. */
function pressOf(element: ReactElement | undefined): () => void {
  if (!element) throw new Error('the header slot rendered nothing');
  return (element.props as { onPress: () => void }).onPress;
}

const lastWith = (key: keyof Options): Options | undefined =>
  [...optionCalls()].reverse().find((options) => key in options);

describe('useHeaderActions', () => {
  beforeEach(() => cfg.navigation.setOptions.mockClear());

  it('sets headerLeft and headerRight that render the actions with the header tint', () => {
    const onClose = vi.fn();
    const onSave = vi.fn();
    renderHook(() =>
      useHeaderActions({
        leading: { kind: 'close', onPress: onClose },
        trailing: { label: 'Save', onPress: onSave, prominent: true, disabled: true },
      }),
    );

    const left = lastWith('headerLeft')?.headerLeft?.({ tintColor: '#123' });
    const right = lastWith('headerRight')?.headerRight?.({ tintColor: '#123' });
    expect(isValidElement(left)).toBe(true);
    expect(left?.props).toMatchObject({ kind: 'close', tintColor: '#123' });
    expect(right?.props).toMatchObject({ label: 'Save', prominent: true, disabled: true, tintColor: '#123' });

    // The forwarders call the latest handlers.
    pressOf(left)();
    pressOf(right)();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('leaves a slot alone when it is not passed', () => {
    renderHook(() => useHeaderActions({ trailing: { label: 'Next', onPress: vi.fn() } }));
    expect(optionCalls().some((options) => 'headerLeft' in options)).toBe(false);
    expect(lastWith('headerRight')?.headerRight).toBeTypeOf('function');
  });

  it('does not call setOptions again when only the onPress identity changes', () => {
    const { rerender } = renderHook(({ onPress }) => useHeaderActions({ trailing: { label: 'Save', onPress } }), {
      initialProps: { onPress: vi.fn() },
    });
    const callsAfterMount = cfg.navigation.setOptions.mock.calls.length;
    const latest = vi.fn();
    rerender({ onPress: latest });
    expect(cfg.navigation.setOptions.mock.calls.length).toBe(callsAfterMount);

    // ...and the header still reaches the newest handler.
    const right = lastWith('headerRight')?.headerRight?.({});
    pressOf(right)();
    expect(latest).toHaveBeenCalledTimes(1);
  });

  it('re-sets the slot when what it shows changes', () => {
    const { rerender } = renderHook(
      ({ loading }) => useHeaderActions({ trailing: { label: 'Save', onPress: vi.fn(), loading } }),
      { initialProps: { loading: false } },
    );
    rerender({ loading: true });
    expect(lastWith('headerRight')?.headerRight?.({}).props).toMatchObject({ loading: true });
  });

  it('clears the slots it set on unmount', () => {
    const { unmount } = renderHook(() =>
      useHeaderActions({
        leading: { kind: 'back', onPress: vi.fn() },
        trailing: { label: 'Next', onPress: vi.fn() },
      }),
    );
    cfg.navigation.setOptions.mockClear();
    unmount();
    expect(optionCalls()).toEqual(expect.arrayContaining([{ headerLeft: undefined }, { headerRight: undefined }]));
  });
});
