// @vitest-environment jsdom
import { createElement, createRef, forwardRef, useImperativeHandle, type ReactNode } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClimbFilterSurfaceHandle, ClimbFilterSurfaceProps } from '../ClimbFilterSurface.types';

vi.hoisted(() => {
  const nodeModule = process.getBuiltinModule('node:module') as unknown as {
    _extensions: Record<string, (module: { exports: unknown }, filename: string) => void>;
  };
  nodeModule._extensions['.xml'] = (module, filename) => {
    module.exports = filename;
  };
});
const native = vi.hoisted(() => ({
  hide: vi.fn(),
  expand: vi.fn(),
  partialExpand: vi.fn(),
  modal: null as Record<string, unknown> | null,
  form: null as Record<string, unknown> | null,
  capture: vi.fn(),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  PlatformColor: (name: string) => name,
  StyleSheet: { create: (styles: unknown) => styles },
  useWindowDimensions: () => ({ height: 800, width: 400 }),
}));
vi.mock('../ComposeHost.android', () => ({
  ComposeHost: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-testid': 'host' }, children),
}));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { label: '#fff', secondaryLabel: '#ccc' },
    brandColors: { primary: '#aaa' },
    sheetSurface: '#222',
  }),
}));
vi.mock('@expo/ui/jetpack-compose/modifiers', () => ({
  fillMaxWidth: () => ({}),
  height: () => ({}),
  padding: () => ({}),
  weight: () => ({}),
}));
vi.mock('@expo/ui/jetpack-compose', () => {
  const Container = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return {
    Column: Container,
    Row: Container,
    Text: Container,
    IconButton: Container,
    TextButton: Container,
    Icon: () => null,
    ModalBottomSheet: forwardRef((props: Record<string, unknown> & { children?: ReactNode }, ref) => {
      native.modal = props;
      useImperativeHandle(ref, () => ({
        hide: native.hide,
        expand: native.expand,
        partialExpand: native.partialExpand,
      }));
      return createElement('div', { 'data-testid': 'native-sheet' }, props.children);
    }),
  };
});
vi.mock('../ClimbFilterForm.android', () => ({
  ClimbFilterForm: forwardRef((props: Record<string, unknown>, ref) => {
    native.form = props;
    useImperativeHandle(ref, () => ({ captureScrollPosition: native.capture }));
    return null;
  }),
}));
import { ClimbFilterSurface } from '../ClimbFilterSurface.android';
function setup() {
  const ref = createRef<ClimbFilterSurfaceHandle>();
  const onChange = vi.fn();
  const props: ClimbFilterSurfaceProps = {
    model: { sections: [] },
    title: 'Filters',
    closeLabel: 'Close',
    resetLabel: 'Reset',
    resetDisabled: true,
    onClosePress: vi.fn(),
    onReset: vi.fn(),
    onChange,
  };
  const view = render(<ClimbFilterSurface ref={ref} {...props} />);
  return { ref, onChange, view };
}
beforeEach(() => {
  vi.clearAllMocks();
  native.modal = null;
  native.form = null;
  native.hide.mockResolvedValue(undefined);
  native.expand.mockResolvedValue(undefined);
  native.partialExpand.mockResolvedValue(undefined);
});
afterEach(cleanup);
describe('native Android filter sheet', () => {
  it('waits for its coordinator, then opens at the partial anchor', () => {
    const { ref, onChange, view } = setup();
    expect(view.queryByTestId('native-sheet')).toBeNull();
    act(() => ref.current?.snapToIndex(0));
    expect(native.modal).toMatchObject({
      skipPartiallyExpanded: false,
      initialFullyExpanded: false,
      sheetGesturesEnabled: true,
      properties: { shouldDismissOnBackPress: true, shouldDismissOnClickOutside: true },
    });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(0);
  });
  it('expands on every name focus, including after an unreported native collapse', async () => {
    const { ref } = setup();
    act(() => ref.current?.present());
    const focus = native.form?.onNameFocus as () => void;
    await act(async () => {
      focus();
      await Promise.resolve();
    });
    await act(async () => {
      focus();
      await Promise.resolve();
    });
    expect(native.expand).toHaveBeenCalledTimes(2);
  });
  it('ignores name focus while its native hide is pending', async () => {
    native.hide.mockImplementation(() => new Promise<void>(() => {}));
    const { ref, onChange } = setup();
    act(() => ref.current?.present());
    const focus = native.form?.onNameFocus as () => void;
    act(() => {
      ref.current?.dismiss();
      focus();
    });
    await act(async () => {});
    expect(native.expand).not.toHaveBeenCalled();
    expect(onChange.mock.calls.map(([index]) => index)).toEqual([0]);
  });
  it('ignores a queued name focus from an older presentation', async () => {
    const { ref, onChange } = setup();
    act(() => ref.current?.present());
    const staleFocus = native.form?.onNameFocus as () => void;
    await act(async () => ref.current?.dismiss());
    act(() => ref.current?.present());
    onChange.mockClear();
    await act(async () => staleFocus());
    expect(native.expand).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });
  it('deduplicates native dismissal against a pending hide completion', async () => {
    let finishHide: (() => void) | undefined;
    native.hide.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishHide = resolve;
        }),
    );
    const { ref, onChange } = setup();
    act(() => ref.current?.present());
    await act(async () => {
      ref.current?.dismiss();
      await Promise.resolve();
    });
    const nativeClose = native.modal?.onDismissRequest as () => void;
    act(nativeClose);
    await act(async () => {
      finishHide?.();
    });
    expect(onChange.mock.calls.filter(([index]) => index === -1)).toHaveLength(1);
  });
  it('ignores a stale hide completion after reopening', async () => {
    let finishHide: (() => void) | undefined;
    native.hide.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishHide = resolve;
        }),
    );
    const { ref, onChange, view } = setup();
    act(() => ref.current?.present());
    await act(async () => {
      ref.current?.dismiss();
      await Promise.resolve();
    });
    act(() => ref.current?.present());
    await act(async () => {
      finishHide?.();
    });
    expect(view.queryByTestId('native-sheet')).not.toBeNull();
    expect(onChange.mock.calls.filter(([index]) => index === -1)).toHaveLength(0);
  });
  it.each(['throw', 'reject'])('finishes dismissal when hide handlers %s', async (failure) => {
    native.hide.mockImplementation(() => {
      if (failure === 'throw') throw new Error('unavailable');
      return Promise.reject(new Error('unavailable'));
    });
    const { ref, onChange, view } = setup();
    act(() => ref.current?.present());
    await act(async () => {
      ref.current?.dismiss();
    });
    expect(view.queryByTestId('native-sheet')).toBeNull();
    expect(onChange.mock.calls.filter(([index]) => index === -1)).toHaveLength(1);
  });
  it('does not hide a new native instance when dismiss and reopen share a turn', async () => {
    const { ref, onChange, view } = setup();
    act(() => ref.current?.present());
    const oldHide = native.hide;
    const replacementHide = vi.fn().mockResolvedValue(undefined);
    act(() => {
      ref.current?.dismiss();
      native.hide = replacementHide;
      ref.current?.present();
    });
    await act(async () => {});
    expect(oldHide).toHaveBeenCalledOnce();
    expect(replacementHide).not.toHaveBeenCalled();
    expect(view.queryByTestId('native-sheet')).not.toBeNull();
    expect(onChange.mock.calls.filter(([index]) => index === -1)).toHaveLength(0);
    native.hide = oldHide;
  });
  it('captures the native form position for a picker handoff', async () => {
    const position = { sectionKey: 'sort', offsetDp: 18, rail: { index: 5, offsetDp: 12 } };
    native.capture.mockResolvedValue(position);
    const { ref } = setup();
    act(() => ref.current?.present());
    await expect(ref.current?.captureScrollPosition()).resolves.toEqual(position);
  });
});
