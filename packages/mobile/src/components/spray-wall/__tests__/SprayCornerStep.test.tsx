// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

type LayoutEvent = { nativeEvent: { layout: { height: number } } };
const controls = vi.hoisted(() => ({
  platform: { OS: 'android' as 'android' | 'ios' },
  viewportHeight: 0,
  photoWidth: 0,
  nativePhotoHeight: 200,
  layouts: new Map<string, (event: LayoutEvent) => void>(),
  markers: [] as { maxWidth: number; maxHeight: number }[],
}));
vi.mock('react-native', () => ({
  Platform: controls.platform,
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({
    children,
    onLayout,
    testID,
  }: {
    children?: ReactNode;
    onLayout?: (event: LayoutEvent) => void;
    testID?: string;
  }) => {
    if (testID && onLayout) controls.layouts.set(testID, onLayout);
    return createElement('div', { 'data-testid': testID }, children);
  },
  ScrollView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  SafeAreaView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  useSafeAreaInsets: () => ({ bottom: 0 }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, brandColors: {} }),
}));
vi.mock('../../../hooks/use-transparent-header-inset', () => ({ useTransparentHeaderInset: () => 0 }));
vi.mock('../../../hooks/use-window-bottom-inset', () => ({ useWindowBottomInset: () => 0 }));
vi.mock('../../../theme/tokens', () => ({ spacing: { 1: 4, 3: 12, 4: 16 } }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Button', () => ({ Button: () => null }));
vi.mock('../use-fitted-photo-stage', () => ({
  MIN_STAGE_HEIGHT: 244,
  useFittedPhotoStage: () => ({
    viewportHeight: controls.viewportHeight,
    maxPhotoWidth: controls.photoWidth,
    // Deliberately lags the explicit Android stage, as native onLayout does.
    maxPhotoHeight: controls.nativePhotoHeight,
    onStageLayout: () => {},
    scrollProps: {},
    onDragActiveChange: () => {},
  }),
}));
vi.mock('../SprayCornerMarker', () => ({
  SprayCornerMarker: (props: { maxWidth: number; maxHeight: number }) => {
    controls.markers.push(props);
    return createElement('div', { 'data-testid': 'corner-marker' });
  },
}));

import { SprayCornerStep } from '../SprayCornerStep';

const props = {
  stepCounter: 'Step 2 of 6',
  title: 'Mark the corners',
  body: 'Drag the rings onto the corners.',
  photo: { uri: 'file:///wall.jpg', width: 1536, height: 2048 },
  value: null,
  onChange: vi.fn(),
  invalid: false,
  canClear: false,
  onClear: vi.fn(),
};

afterEach(() => {
  cleanup();
  controls.platform.OS = 'android';
  controls.viewportHeight = 0;
  controls.photoWidth = 0;
  controls.markers = [];
  controls.layouts.clear();
});

describe('SprayCornerStep initial Android layout', () => {
  it('seeds the first marker from the reserved stage, never its stale native minimum', () => {
    const view = render(<SprayCornerStep {...props} />);
    act(() => {
      controls.layouts.get('spray-corner-controls')?.({ nativeEvent: { layout: { height: 160 } } });
      controls.layouts.get('spray-corner-footer')?.({ nativeEvent: { layout: { height: 32 } } });
    });
    expect(controls.markers).toHaveLength(0);
    controls.viewportHeight = 600;
    view.rerender(<SprayCornerStep {...props} />);
    expect(controls.markers).toHaveLength(0);
    controls.photoWidth = 328;
    view.rerender(<SprayCornerStep {...props} />);
    // 600 - controls 160 - footer 32 - padding/gaps 52 - handles 44.
    expect(controls.markers[0]).toMatchObject({ maxWidth: 328, maxHeight: 312 });
    controls.viewportHeight = 700;
    view.rerender(<SprayCornerStep {...props} />);
    expect(controls.markers.at(-1)).toMatchObject({ maxHeight: 412 });
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it('continues to use the measured native stage on iOS', () => {
    controls.platform.OS = 'ios';
    controls.photoWidth = 328;
    render(<SprayCornerStep {...props} />);
    expect(controls.markers[0]).toMatchObject({ maxHeight: 200 });
  });
});
