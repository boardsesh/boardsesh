// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createElement, isValidElement, type ReactElement } from 'react';

const cfg = vi.hoisted(() => ({ navigation: { setOptions: vi.fn() } }));
vi.mock('expo-router', () => ({ useNavigation: () => cfg.navigation }));

// The buttons themselves are SheetTopBar's twins and are not under test here;
// stand-ins keep this test off the native tree.
vi.mock('../../components/HeaderActionButtons', () => ({
  HeaderLeadingButton: () => null,
  HeaderTrailingGroup: () => null,
}));

import { useHeaderActions } from '../use-header-actions';

type SlotRenderer = (props: { tintColor?: string }) => ReactElement;
type Options = { headerLeft?: SlotRenderer; headerRight?: SlotRenderer };

const optionCalls = (): Options[] => cfg.navigation.setOptions.mock.calls.map(([options]) => options as Options);
/** The onPress a rendered header element was handed; fails the test if there is no element. */
function pressOf(element: ReactElement | undefined): () => void {
  if (!element) throw new Error('the header slot rendered nothing');
  const props = element.props as { onPress?: () => void; trailing?: { onPress: () => void } };
  const onPress = props.onPress ?? props.trailing?.onPress;
  if (!onPress) throw new Error('the header slot has no action');
  return onPress;
}

/** The trailing action handed to headerRight's group. */
function trailingOf(element: ReactElement | undefined): object | undefined {
  if (!element) throw new Error('the header slot rendered nothing');
  return (element.props as { trailing?: object }).trailing;
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
    expect(right?.props).toMatchObject({ tintColor: '#123' });
    expect(trailingOf(right)).toMatchObject({ label: 'Save', prominent: true, disabled: true });

    // The forwarders call the latest handlers.
    pressOf(left)();
    pressOf(right)();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('hands a cancel action its custom word', () => {
    renderHook(() => useHeaderActions({ leading: { kind: 'cancel', label: 'Not now', onPress: vi.fn() } }));
    const left = lastWith('headerLeft')?.headerLeft?.({ tintColor: '#123' });
    expect(left?.props).toMatchObject({ kind: 'cancel', label: 'Not now' });
  });

  it('hands the leading action its disabled state, and re-sets the slot when it changes', () => {
    const { rerender } = renderHook(
      ({ disabled }) => useHeaderActions({ leading: { kind: 'back', onPress: vi.fn(), disabled } }),
      { initialProps: { disabled: true } },
    );
    expect(lastWith('headerLeft')?.headerLeft?.({ tintColor: '#123' })?.props).toMatchObject({
      kind: 'back',
      disabled: true,
    });
    rerender({ disabled: false });
    expect(lastWith('headerLeft')?.headerLeft?.({ tintColor: '#123' })?.props).toMatchObject({ disabled: false });
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
    expect(trailingOf(lastWith('headerRight')?.headerRight?.({}))).toMatchObject({ loading: true });
  });

  it('never clears a slot: not on unmount, not when the action is dropped or null', () => {
    const { rerender, unmount } = renderHook(
      ({ on }) =>
        useHeaderActions(
          on
            ? { leading: { kind: 'back', onPress: vi.fn() }, trailing: { label: 'Next', onPress: vi.fn() } }
            : { leading: null, trailing: undefined },
        ),
      { initialProps: { on: true } },
    );
    cfg.navigation.setOptions.mockClear();
    rerender({ on: false });
    unmount();
    expect(cfg.navigation.setOptions).not.toHaveBeenCalled();
  });

  it('with clearOnUnmount, clears only on unmount, and only the slots it wrote', () => {
    const { rerender, unmount } = renderHook(
      ({ label }) => useHeaderActions({ trailing: { label, onPress: vi.fn() }, clearOnUnmount: true }),
      { initialProps: { label: 'Save' } },
    );
    cfg.navigation.setOptions.mockClear();
    // A re-render that changes what the bar shows re-sets it; it never clears.
    rerender({ label: 'Saving' });
    expect(optionCalls()).toHaveLength(1);
    expect(optionCalls()[0]?.headerRight).toBeTypeOf('function');

    cfg.navigation.setOptions.mockClear();
    unmount();
    // headerRight only: the layout's headerLeft (a back chevron, an X) stays.
    expect(optionCalls()).toStrictEqual([{ headerRight: undefined }]);
  });

  it('with clearOnUnmount, clears a leading action it wrote as well', () => {
    const { unmount } = renderHook(() =>
      useHeaderActions({
        leading: { kind: 'cancel', onPress: vi.fn() },
        trailing: { label: 'Save', onPress: vi.fn() },
        clearOnUnmount: true,
      }),
    );
    cfg.navigation.setOptions.mockClear();
    unmount();
    expect(optionCalls()).toStrictEqual([{ headerLeft: undefined, headerRight: undefined }]);
  });

  it('with clearOnUnmount but nothing written, leaves the header alone on unmount', () => {
    const { unmount } = renderHook(() => useHeaderActions({ leading: null, clearOnUnmount: true }));
    unmount();
    expect(cfg.navigation.setOptions).not.toHaveBeenCalled();
  });

  it('renders an accessory before the trailing action, and alone', () => {
    const accessory = createElement('span', null, '?');
    renderHook(() => useHeaderActions({ trailingAccessory: accessory }));
    const right = lastWith('headerRight')?.headerRight?.({});
    expect(right?.props).toMatchObject({ accessory, trailing: undefined });
  });
});
