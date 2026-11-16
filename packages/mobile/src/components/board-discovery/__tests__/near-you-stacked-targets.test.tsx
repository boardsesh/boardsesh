// @vitest-environment jsdom
//
// Near you above Your boards, laid out by Yoga: the quiet line's action sits
// under Near you's Map and over Your boards' Manage. Each target is full size,
// and none reaches into another's, on either look, beside the title and with
// the header actions wrapped under it (an accessibility text size).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const ctrl = vi.hoisted(() => ({ variant: 'liquidGlass' as 'liquidGlass' | 'material' }));

vi.mock('react-native', async () => {
  const { flattenStyle } = await import('../../../../test/flatten-style');
  return {
    Platform: { OS: 'ios' },
    PlatformColor: (name: string) => name,
    DynamicColorIOS: (appearances: { light: string }) => appearances.light,
    StyleSheet: { create: <T,>(styles: T): T => styles, hairlineWidth: 0.5 },
    View: ({ children, style, testID }: { children?: ReactNode; style?: unknown; testID?: string }) =>
      createElement('div', { 'data-testid': testID, 'data-style': JSON.stringify(flattenStyle(style)) }, children),
  };
});
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key.split('.').at(-1) }) }));
vi.mock('../../Text', async () => {
  const { flattenStyle } = await import('../../../../test/flatten-style');
  return {
    Text: ({
      children,
      variant,
      accessibilityRole,
      style,
    }: {
      children?: ReactNode;
      variant?: string;
      accessibilityRole?: string;
      style?: unknown;
    }) =>
      createElement(
        'span',
        {
          'data-variant': variant,
          'data-style': JSON.stringify(flattenStyle(style)),
          role: accessibilityRole === 'header' ? 'heading' : undefined,
        },
        children,
      ),
  };
});
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('../../PressableSurface', async () => {
  const { flattenStyle } = await import('../../../../test/flatten-style');
  return {
    PressableSurface: ({
      children,
      onPress,
      accessibilityLabel,
      style,
    }: {
      children?: ReactNode;
      onPress: () => void;
      accessibilityLabel?: string;
      style?: unknown;
    }) =>
      createElement(
        'button',
        { onClick: onPress, 'aria-label': accessibilityLabel, 'data-style': JSON.stringify(flattenStyle(style)) },
        children,
      ),
  };
});
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ variant: ctrl.variant, systemColors: { accent: '#ACCENT', tertiaryLabel: '#TERTIARY' } }),
}));

import { View } from 'react-native';
import { ShelfSection } from '../../ShelfHeader';
import { TEXT_ACTION_MIN_TARGET } from '../../TextAction';
import { textStylesByVariant, type TextVariant } from '../../../theme/typography';
import { layOutRendered } from '../../../../test/yoga-rendered-layout';
import { NearbyQuietStatus } from '../NearbyQuietStatus';

afterEach(() => {
  cleanup();
  ctrl.variant = 'liquidGlass';
});

function layOut(root: Element, width: number) {
  return layOutRendered(root, width, (element) => {
    if (element.tagName === 'SPAN') {
      const textVariant = element.getAttribute('data-variant') as TextVariant;
      return {
        width: (element.textContent ?? '').length * 8,
        height: textStylesByVariant[ctrl.variant][textVariant].lineHeight,
      };
    }
    return element.tagName === 'I' ? { width: 12, height: 12 } : null;
  });
}

describe('Near you over Your boards', () => {
  it.each([
    ['liquidGlass', 370],
    ['liquidGlass', 120],
    ['material', 370],
    ['material', 120],
  ] as const)('keeps every %s target whole and apart at %ipt wide', (variant, width) => {
    ctrl.variant = variant;
    render(
      <View testID="page">
        <ShelfSection title="Near you" action={{ label: 'Map', onPress: vi.fn() }}>
          <NearbyQuietStatus
            state="nearby_error"
            allShownAbove={false}
            onRetryNearby={vi.fn()}
            onOpenSettings={vi.fn()}
            onFindGymOnMap={vi.fn()}
          />
        </ShelfSection>
        <ShelfSection title="Your boards" action={{ label: 'Manage', onPress: vi.fn() }}>
          <View testID="your-boards-rows" />
        </ShelfSection>
      </View>,
    );
    const layout = layOut(screen.getByTestId('page'), width);
    try {
      const [map, retry, manage] = ['Map', 'errorRetry', 'Manage'].map((name) =>
        layout.boxOf(screen.getByRole('button', { name })),
      );
      if (!map || !retry || !manage) throw new Error('A target is missing');
      for (const target of [map, retry, manage]) {
        expect(target.height).toBeGreaterThanOrEqual(TEXT_ACTION_MIN_TARGET[variant]);
      }
      expect(map.bottom).toBeLessThanOrEqual(retry.top);
      expect(retry.bottom).toBeLessThanOrEqual(manage.top);
      // Retry's line still sits 8pt under Near you's header.
      const nearYouTitle = layout.boxOf(screen.getByRole('heading', { name: 'Near you' }));
      const retryLabel = layout.boxOf(screen.getByText('errorRetry'));
      const mapLabel = layout.boxOf(screen.getByText('Map'));
      expect(retryLabel.top).toBe(Math.max(nearYouTitle.bottom, mapLabel.bottom) + 8);
    } finally {
      layout.free();
    }
  });
});
