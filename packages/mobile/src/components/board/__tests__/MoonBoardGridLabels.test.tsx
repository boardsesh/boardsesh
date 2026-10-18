// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

// The label art is a bundled module id; everything else in a board stack is a
// file URI. Tell them apart in the DOM.
vi.mock('expo-image', () => ({
  Image: ({
    source,
    testID,
    pointerEvents,
  }: {
    source: number | { uri: string };
    testID?: string;
    pointerEvents?: string;
  }) =>
    createElement('img', {
      src: typeof source === 'number' ? `module:${source}` : source.uri,
      'data-testid': testID,
      'data-pointer-events': pointerEvents,
    }),
}));

vi.mock('../../../lib/app-visibility', () => ({ useIsAppBackgrounded: () => false }));

vi.mock('../../../lib/board-backgrounds-manifest', () => ({
  BOARD_BACKGROUND_ASSETS: {
    'moonboard/moonboard-bg.webp': 400,
    'moonboard/moonboard-bg.dark.webp': 401,
    'moonboard/minimoonboard-bg.webp': 500,
    'moonboard/minimoonboard-bg.dark.webp': 501,
  },
}));

const appearance = vi.hoisted(() => ({ colorScheme: 'light' as 'light' | 'dark' }));
vi.mock('../../../hooks/use-native-climb-render', () => ({
  useNativeClimbRender: () => ({
    overlayUri: 'file:///overlay.png',
    overlayLoadKey: 'file:///overlay.png',
    onOverlayLoad: () => {},
    onOverlayError: () => {},
    onOverlayMounted: () => {},
    backgroundPaths: ['/bundled/moonboard2024/woodenholds.webp'],
    missingBackgroundCount: 0,
    rendererUnavailable: false,
    artworkIdentity: {
      boardName: 'moonboard',
      layoutId: 3,
      sizeId: 1,
      setIds: '8',
      frames: 'p1r42',
      renderSignature: 'aura',
      colorScheme: appearance.colorScheme,
    },
  }),
}));

import { MoonBoardGridLabels } from '../MoonBoardGridLabels';
import { BoardImageNative } from '../../BoardImageNative';
import { setSetting, DEFAULT_SETTINGS } from '../../../settings';

const LABELS = '[data-testid="moonboard-grid-labels"]';

const MOONBOARD_2024 = {
  frames: 'p1r42',
  boardName: 'moonboard' as const,
  layoutId: 3,
  sizeId: 1,
  setIds: '8',
  boardWidth: 650,
  boardHeight: 1000,
};

afterEach(() => {
  appearance.colorScheme = 'light';
  setSetting('moonboardGridLabels', DEFAULT_SETTINGS.moonboardGridLabels);
});

describe('MoonBoardGridLabels', () => {
  it('is on by default', () => {
    expect(DEFAULT_SETTINGS.moonboardGridLabels).toBe(true);
  });

  it('draws the full-size label art, untouchable so taps reach the holds', () => {
    const { container } = render(<MoonBoardGridLabels layoutId={3} colorScheme={appearance.colorScheme} />);
    const labels = container.querySelector(LABELS)!;
    expect(labels.getAttribute('src')).toBe('module:400');
    expect(labels.getAttribute('data-pointer-events')).toBe('none');
  });

  it('draws the dark copy in dark mode', () => {
    appearance.colorScheme = 'dark';
    const { container } = render(<MoonBoardGridLabels layoutId={3} colorScheme={appearance.colorScheme} />);
    expect(container.querySelector(LABELS)!.getAttribute('src')).toBe('module:401');
  });

  it("draws the Mini's 1-12 art on a Mini MoonBoard", () => {
    const { container } = render(<MoonBoardGridLabels layoutId={7} colorScheme={appearance.colorScheme} />);
    expect(container.querySelector(LABELS)!.getAttribute('src')).toBe('module:500');
  });

  it('draws nothing when the climber has turned the labels off', () => {
    setSetting('moonboardGridLabels', false);
    const { container } = render(<MoonBoardGridLabels layoutId={3} colorScheme={appearance.colorScheme} />);
    expect(container.querySelector(LABELS)).toBeNull();
  });
});

describe('BoardImageNative showGridLabels', () => {
  it('draws the labels above the holds overlay on a MoonBoard', () => {
    const { container } = render(<BoardImageNative {...MOONBOARD_2024} showGridLabels />);
    const labels = container.querySelector(LABELS);
    const overlay = container.querySelector('img[src="file:///overlay.png"]');
    expect(labels).not.toBeNull();
    expect(overlay).not.toBeNull();
    // Later in document order = drawn on top.
    expect(overlay!.compareDocumentPosition(labels!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('leaves them off a surface that does not ask (thumbnails, cards)', () => {
    const { container } = render(<BoardImageNative {...MOONBOARD_2024} />);
    expect(container.querySelector(LABELS)).toBeNull();
  });

  it('never draws them on another board', () => {
    const { container } = render(
      <BoardImageNative {...MOONBOARD_2024} boardName="kilter" layoutId={1} sizeId={10} showGridLabels />,
    );
    expect(container.querySelector(LABELS)).toBeNull();
  });

  // The art's letters and numbers would read backwards.
  it('never draws them on a mirrored board', () => {
    const { container } = render(<BoardImageNative {...MOONBOARD_2024} mirrored showGridLabels />);
    expect(container.querySelector(LABELS)).toBeNull();
  });

  it('draws nothing when the climber has turned the labels off', () => {
    setSetting('moonboardGridLabels', false);
    const { container } = render(<BoardImageNative {...MOONBOARD_2024} showGridLabels />);
    expect(container.querySelector(LABELS)).toBeNull();
  });

  // Same scheme as the art under it, so the two switch to their dark copies together.
  it('draws the dark label copy when the board art resolved dark', () => {
    appearance.colorScheme = 'dark';
    const { container } = render(<BoardImageNative {...MOONBOARD_2024} showGridLabels />);
    expect(container.querySelector(LABELS)!.getAttribute('src')).toBe('module:401');
  });
});
