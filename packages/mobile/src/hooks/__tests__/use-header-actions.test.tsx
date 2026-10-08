// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createElement, isValidElement, type ReactElement } from 'react';

const cfg = vi.hoisted(() => ({
  navigation: { setOptions: vi.fn() },
  glass: false,
  variant: 'liquidGlass' as 'liquidGlass' | 'material',
}));
vi.mock('expo-router', () => ({ useNavigation: () => cfg.navigation }));
vi.mock('../use-glass-capability', () => ({ useGlassCapability: () => cfg.glass }));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({ variant: cfg.variant, brandColors: { primary: '#brand', error: '#error' } }),
}));

// The buttons themselves are SheetTopBar's twins and are not under test here;
// stand-ins keep this test off the native tree.
vi.mock('../../components/HeaderActionButtons', () => ({
  HeaderLeadingButton: () => null,
  HeaderTrailingGroup: () => null,
  HeaderTrailingButton: () => null,
}));

import { ownHeaderRight, useHeaderActions } from '../use-header-actions';

type SlotRenderer = (props: { tintColor?: string }) => ReactElement;
type NativeItem = {
  type: string;
  element?: ReactElement;
  hidesSharedBackground?: boolean;
  icon?: { type: string; name: string };
  label: string;
  variant?: string;
  tintColor?: string;
  disabled?: boolean;
  onPress: () => void;
  labelStyle?: { fontWeight?: string };
  accessibilityLabel?: string;
};
type Options = {
  headerLeft?: SlotRenderer;
  headerRight?: SlotRenderer;
  unstable_headerRightItems?: (props: { tintColor?: string }) => NativeItem[];
};

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
  beforeEach(() => {
    cfg.navigation.setOptions.mockClear();
    cfg.glass = false;
    cfg.variant = 'liquidGlass';
  });

  it('sets headerLeft and headerRight that render the actions', () => {
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
    expect(left?.props).toMatchObject({ kind: 'close' });
    // The buttons colour themselves from the spec, not from the header's tint.
    expect(left?.props).not.toHaveProperty('tintColor');
    expect(right?.props).not.toHaveProperty('tintColor');
    expect(trailingOf(right)).toMatchObject({ label: 'Save', prominent: true, disabled: true });
    // Without iOS 26 glass there is no native item.
    expect(lastWith('headerRight')?.unstable_headerRightItems).toBeUndefined();

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
    expect(optionCalls()).toStrictEqual([{ headerRight: undefined, unstable_headerRightItems: undefined }]);
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
    expect(optionCalls()).toStrictEqual([
      { headerLeft: undefined, headerRight: undefined, unstable_headerRightItems: undefined },
    ]);
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

describe('useHeaderActions — native bar items (iOS 26 Liquid Glass)', () => {
  beforeEach(() => {
    cfg.navigation.setOptions.mockClear();
    cfg.glass = true;
    cfg.variant = 'liquidGlass';
  });

  const nativeItems = (): NativeItem[] | undefined => lastWith('headerRight')?.unstable_headerRightItems?.({});

  it('hands a prominent confirm to a native prominent bar item in the brand tint', () => {
    const onSave = vi.fn();
    renderHook(() =>
      useHeaderActions({
        trailing: { label: 'Save', onPress: onSave, prominent: true, accessibilityLabel: 'Save wall' },
      }),
    );
    const items = nativeItems();
    expect(items).toHaveLength(1);
    expect(items?.[0]).toMatchObject({
      type: 'button',
      label: 'Save',
      variant: 'prominent',
      tintColor: '#brand',
      disabled: false,
      labelStyle: { fontWeight: '600' },
      // The confirm is the ✓; its label is the spoken name.
      icon: { type: 'sfSymbol', name: 'checkmark' },
      accessibilityLabel: 'Save wall',
    });
    items?.[0]?.onPress();
    expect(onSave).toHaveBeenCalledTimes(1);
    // headerRight stays set as the JS fallback.
    expect(lastWith('headerRight')?.headerRight).toBeTypeOf('function');
  });

  it('a forward action is a native prominent item that shows its label, no ✓', () => {
    renderHook(() =>
      useHeaderActions({ trailing: { kind: 'forward', label: 'Next', onPress: vi.fn(), prominent: true } }),
    );
    const item = nativeItems()?.[0];
    expect(item).toMatchObject({ label: 'Next', variant: 'prominent', accessibilityLabel: 'Next' });
    expect(item?.icon).toBeUndefined();
  });

  it('a confirm with a lock glyph carries the lock symbol instead of the ✓', () => {
    renderHook(() =>
      useHeaderActions({ trailing: { kind: 'confirm', label: 'Save', onPress: vi.fn(), icon: 'lock' } }),
    );
    expect(nativeItems()?.[0]?.icon).toEqual({ type: 'sfSymbol', name: 'lock' });
  });

  it('passes disabled to the native item; a destructive confirm is red text, never a red ✓', () => {
    renderHook(() =>
      useHeaderActions({
        trailing: { label: 'End', onPress: vi.fn(), prominent: true, destructive: true, disabled: true },
      }),
    );
    const item = nativeItems()?.[0];
    expect(item).toMatchObject({ disabled: true, tintColor: '#error', variant: 'plain' });
    expect(item?.icon).toBeUndefined();
  });

  it('a send is a prominent item with its label, no ✓', () => {
    renderHook(() => useHeaderActions({ trailing: { kind: 'send', label: 'Report', onPress: vi.fn() } }));
    const item = nativeItems()?.[0];
    expect(item).toMatchObject({ label: 'Report', variant: 'prominent', tintColor: '#brand' });
    expect(item?.icon).toBeUndefined();
  });

  it('a plain action is a plain native item in the header tint', () => {
    renderHook(() => useHeaderActions({ trailing: { label: 'Clear', onPress: vi.fn() } }));
    const item = nativeItems()?.[0];
    expect(item).toMatchObject({ type: 'button', label: 'Clear', variant: 'plain' });
    expect(item?.tintColor).toBeUndefined();
  });

  it('while it saves, stays in the items as a custom item drawing its own ✓ circle, not the JS headerRight', () => {
    const { rerender } = renderHook(
      ({ loading }) => useHeaderActions({ trailing: { label: 'Save', onPress: vi.fn(), prominent: true, loading } }),
      { initialProps: { loading: false } },
    );
    expect(nativeItems()?.[0]?.type).toBe('button');
    rerender({ loading: true });
    const saving = nativeItems()?.[0];
    expect(saving).toMatchObject({ type: 'custom', hidesSharedBackground: true });
    expect(saving?.element?.props).toMatchObject({ loading: true, standalone: true, label: 'Save' });
    rerender({ loading: false });
    expect(nativeItems()?.[0]?.type).toBe('button');
  });

  it('a plain action saving keeps UIKit glass around its text', () => {
    renderHook(() => useHeaderActions({ trailing: { label: 'Clear', onPress: vi.fn(), loading: true } }));
    expect(nativeItems()?.[0]).toMatchObject({ type: 'custom', hidesSharedBackground: false });
  });

  it('with an accessory, both go custom, the accessory first, so their order holds', () => {
    const accessory = createElement('span', null, '?');
    renderHook(() =>
      useHeaderActions({
        trailing: { label: 'Next', onPress: vi.fn(), prominent: true },
        trailingAccessory: accessory,
      }),
    );
    const items = nativeItems();
    expect(items?.map((item) => item.type)).toEqual(['custom', 'custom']);
    expect(items?.[0]?.element).toBe(accessory);
    expect(items?.[1]?.element?.props).toMatchObject({ label: 'Next', standalone: true });
  });

  it('keeps the JS headerRight on Material, and before iOS 26 glass', () => {
    cfg.variant = 'material';
    renderHook(() => useHeaderActions({ trailing: { label: 'Save', onPress: vi.fn(), prominent: true } }));
    expect(nativeItems()).toBeUndefined();
    cfg.navigation.setOptions.mockClear();

    cfg.variant = 'liquidGlass';
    cfg.glass = false;
    renderHook(() => useHeaderActions({ trailing: { label: 'Save', onPress: vi.fn(), prominent: true } }));
    expect(nativeItems()).toBeUndefined();
  });

  it('ownHeaderRight clears the native item whenever a screen sets the right side itself', () => {
    const render = () => createElement('span');
    expect(ownHeaderRight(render)).toStrictEqual({ headerRight: render, unstable_headerRightItems: undefined });
    expect(ownHeaderRight(undefined)).toStrictEqual({ headerRight: undefined, unstable_headerRightItems: undefined });
  });
});
