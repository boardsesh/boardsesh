// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const previewTheme = vi.hoisted(() => ({
  variant: 'liquidGlass' as 'liquidGlass' | 'material',
  scheme: 'dark' as 'dark' | 'light',
}));

vi.mock('react-native', () => ({
  View: ({
    children,
    testID,
    accessibilityLabel,
    style,
  }: {
    children?: ReactNode;
    testID?: string;
    accessibilityLabel?: string;
    style?: unknown;
  }) => {
    const flattened = Object.assign({}, ...[style].flat(10).filter(Boolean));
    return createElement(
      'div',
      {
        'data-testid': testID,
        'aria-label': accessibilityLabel,
        'data-flex': flattened.flex,
        'data-width': flattened.width,
        'data-background': flattened.backgroundColor,
      },
      children,
    );
  },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
vi.mock('../../../theme/tokens', () => ({
  borderRadius: { md: 8, lg: 12 },
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key),
  }),
}));
vi.mock('../../Icon', () => ({
  Icon: ({ name, color, size }: { name: string; color: string; size: number }) =>
    createElement('i', { 'data-icon': name, 'data-color': color, 'data-size': size }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    variant: previewTheme.variant,
    brandColors: { success: 'green' },
    systemColors: {
      label: previewTheme.scheme === 'dark' ? '#FFFFFF' : '#1C1C1E',
      secondaryLabel: previewTheme.scheme === 'dark' ? '#D0D0D0' : '#3C3C43',
      separator: 'separator',
      secondaryBackground: 'surface',
      tertiaryFill: 'fill',
    },
  }),
}));

import { FALLBACK_PREVIEW_BOARD, PlayerButtonsPreview } from '../PlayerButtonsPreview';
import { DEFAULT_PLAYER_BUTTONS } from '../../../lib/player-buttons';

afterEach(() => {
  cleanup();
  previewTheme.variant = 'liquidGlass';
  previewTheme.scheme = 'dark';
});

const TENSION = { ...FALLBACK_PREVIEW_BOARD, supportsMirroring: true };
const icons = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-icon]')].map((icon) => icon.getAttribute('data-icon'));

function preview(overrides: Partial<Parameters<typeof PlayerButtonsPreview>[0]> = {}) {
  return render(
    createElement(PlayerButtonsPreview, {
      buttons: DEFAULT_PLAYER_BUTTONS,
      previousNext: false,
      position: 'below',
      board: FALLBACK_PREVIEW_BOARD,
      ...overrides,
    }),
  );
}

describe('PlayerButtonsPreview', () => {
  // #7000: [♡] [⏮] [✓] [⏭] [☰] over the full-width wall button.
  it("draws today's Kilter bar under the board, and says it in one sentence", () => {
    const screen = preview();
    expect(icons(screen.container)).toEqual(['angle', 'favorite', 'tick.fill', 'share', 'queue', 'lightbulb']);
    expect(screen.queryByText('40°')).toBeNull();
    expect(screen.getByTestId('player-buttons-preview').getAttribute('aria-label')).toBe(
      'mobile.settings.playerButtons.previewLabel ' +
        JSON.stringify({
          position: 'mobile.settings.playerButtons.position.below',
          buttons: [
            'mobile.settings.playerButtons.buttons.angle',
            'mobile.settings.playerButtons.buttons.favorite',
            'mobile.settings.playerButtons.fixed.log',
            'mobile.settings.playerButtons.buttons.share',
            'mobile.settings.playerButtons.buttons.queue',
            'mobile.settings.playerButtons.fixed.boardLight',
          ].join(', '),
        }),
    );
  });

  it('draws the board it stands for: Mirror replaces Angle on Tension', () => {
    const screen = preview({ board: { ...TENSION, angleAvailable: false } });
    expect(icons(screen.container)).toEqual(['mirror', 'favorite', 'tick.fill', 'share', 'queue', 'lightbulb']);
  });

  it('fills the fixed-angle preview with Play next and announces its label', () => {
    const screen = preview({ board: { ...FALLBACK_PREVIEW_BOARD, angleAvailable: false } });
    expect(icons(screen.container)).toEqual(['queue.next', 'favorite', 'tick.fill', 'share', 'queue', 'lightbulb']);
    expect(screen.getByTestId('player-buttons-preview').getAttribute('aria-label')).toContain(
      'mobile.settings.playerButtons.buttons.playNext',
    );
  });

  it('shows the composite hero Tick in proportion to the neighboring icons', () => {
    const screen = preview();
    const tick = screen.container.querySelector('[data-icon="tick.fill"]');
    expect(tick?.getAttribute('data-color')).toBe('#FFFFFF');
    expect(tick?.getAttribute('data-size')).toBe('32');
    expect(tick?.parentElement?.getAttribute('data-background')).toBeNull();
  });

  it.each([
    ['liquidGlass', 'dark', '#FFFFFF'],
    ['liquidGlass', 'light', '#1C1C1E'],
    ['material', 'dark', '#D0D0D0'],
    ['material', 'light', '#3C3C43'],
  ] as const)('uses the neutral action color for the Tick preview (%s, %s)', (variant, scheme, expectedColor) => {
    previewTheme.variant = variant;
    previewTheme.scheme = scheme;
    const screen = preview();
    const tick = screen.container.querySelector('[data-icon="tick.fill"]');
    const share = screen.container.querySelector('[data-icon="share"]');
    expect(tick?.getAttribute('data-color')).toBe(expectedColor);
    expect(tick?.getAttribute('data-color')).toBe(share?.getAttribute('data-color'));
    expect(tick?.getAttribute('data-size')).toBe('32');
    expect(tick?.parentElement?.getAttribute('data-background')).toBeNull();
  });

  it('shows and announces navigation instead of the two inner actions when enabled', () => {
    const screen = preview({ previousNext: true });
    expect(icons(screen.container)).toEqual(['angle', 'skip.previous', 'tick.fill', 'skip.next', 'queue', 'lightbulb']);
    const label = screen.getByTestId('player-buttons-preview').getAttribute('aria-label');
    expect(label).toContain('mobile.settings.playerButtons.fixed.previous');
    expect(label).toContain('mobile.settings.playerButtons.fixed.next');
    expect(label).not.toContain('mobile.settings.playerButtons.buttons.share');
  });

  it('puts the bar above the board when asked, and the board gets what the bar leaves', () => {
    const screen = preview({ position: 'above' });
    const frame = screen.getByTestId('player-buttons-preview');
    const board = [...frame.children].find((child) => child.getAttribute('data-flex') === '1');
    expect(board).toBe(frame.lastElementChild);
  });

  it('leaves empty slots for buttons switched off, and for ⏮ ⏭ with Previous and next off, and keeps the wall button', () => {
    const allOff = {
      order: DEFAULT_PLAYER_BUTTONS.order,
      visible: { mirror: false, favorite: false, angle: false, share: false, queue: false, playNext: false },
    };
    const screen = preview({ buttons: allOff, previousNext: false });
    expect(icons(screen.container)).toEqual(['tick.fill', 'lightbulb']);
  });
});
