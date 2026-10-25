// @vitest-environment jsdom
import { Children, createElement, type ReactNode } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockViewProps = {
  children?: ReactNode;
  collapsable?: boolean;
  pointerEvents?: string;
  style?: unknown;
  testID?: string;
};

const { mocks, absoluteFill, flattenStyle } = vi.hoisted(() => {
  function flatten(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
    return style && typeof style === 'object' ? (style as Record<string, unknown>) : {};
  }
  return {
    mocks: {
      platform: { OS: 'android' as string },
      nativeAvailable: { current: true },
      nativeChildCounts: [] as number[],
    },
    absoluteFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
    flattenStyle: flatten,
  };
});

vi.mock('react-native', () => ({
  Platform: mocks.platform,
  StyleSheet: { absoluteFill },
  View: ({ children, collapsable, pointerEvents, style, testID }: MockViewProps) =>
    createElement(
      'div',
      {
        'data-testid': testID ?? 'rn-view',
        'data-collapsable': String(collapsable),
        'data-pointer-events': pointerEvents,
        'data-style': JSON.stringify(flattenStyle(style)),
      },
      children,
    ),
}));

vi.mock('../../../../modules/spray-editor-input/src/index', () => ({
  get NativeSprayEditorKeyScope() {
    if (!mocks.nativeAvailable.current) return null;
    return ({ children, style }: MockViewProps) => {
      mocks.nativeChildCounts.push(Children.count(children));
      return createElement(
        'section',
        { 'data-testid': 'native-scope', 'data-style': JSON.stringify(flattenStyle(style)) },
        children,
      );
    };
  },
}));

import { SprayEditorKeyScope } from '../SprayEditorKeyScope';

const outerStyle = { flex: 1, backgroundColor: '#000' };
const contentStyle = { alignItems: 'center' } as const;

function renderScope() {
  return render(
    <SprayEditorKeyScope
      commands={[]}
      onShortcut={() => {}}
      onPencilGesture={() => {}}
      style={outerStyle}
      contentStyle={contentStyle}
    >
      <span data-testid="board" />
      <span data-testid="count-capsule" />
      <span data-testid="bottom-bar" />
    </SprayEditorKeyScope>,
  );
}

beforeEach(() => {
  mocks.platform.OS = 'android';
  mocks.nativeAvailable.current = true;
  mocks.nativeChildCounts.length = 0;
});

afterEach(cleanup);

describe('SprayEditorKeyScope', () => {
  it('on Android hands the native LinearLayout one full-size, non-collapsable child', () => {
    const view = renderScope();
    // ExpoView re-lays its direct children in a row, so it must only ever have one.
    expect(mocks.nativeChildCounts.at(-1)).toBe(1);
    const scope = view.getByTestId('native-scope');
    expect(JSON.parse(scope.getAttribute('data-style') ?? '{}')).toEqual(outerStyle);
    const wrapper = scope.firstElementChild as HTMLElement;
    expect(wrapper.getAttribute('data-testid')).toBe('rn-view');
    expect(wrapper.getAttribute('data-collapsable')).toBe('false');
    expect(wrapper.getAttribute('data-pointer-events')).toBe('box-none');
    expect(JSON.parse(wrapper.getAttribute('data-style') ?? '{}')).toEqual({ ...absoluteFill, ...contentStyle });
    for (const testId of ['board', 'count-capsule', 'bottom-bar']) {
      expect(wrapper.contains(view.getByTestId(testId))).toBe(true);
    }
  });

  it('on iOS keeps the children directly under the native view', () => {
    mocks.platform.OS = 'ios';
    const view = renderScope();
    expect(mocks.nativeChildCounts.at(-1)).toBe(3);
    const scope = view.getByTestId('native-scope');
    expect(JSON.parse(scope.getAttribute('data-style') ?? '{}')).toEqual({ ...outerStyle, ...contentStyle });
    expect(view.getByTestId('bottom-bar').parentElement).toBe(scope);
  });

  it('falls back to a plain View with the children directly inside when the module is missing', () => {
    mocks.nativeAvailable.current = false;
    const view = renderScope();
    expect(view.queryByTestId('native-scope')).toBeNull();
    const fallback = view.getByTestId('rn-view');
    expect(JSON.parse(fallback.getAttribute('data-style') ?? '{}')).toEqual({ ...outerStyle, ...contentStyle });
    expect(view.getByTestId('bottom-bar').parentElement).toBe(fallback);
  });
});
