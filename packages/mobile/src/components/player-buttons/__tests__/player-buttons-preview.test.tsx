// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

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
      { 'data-testid': testID, 'aria-label': accessibilityLabel, 'data-flex': flattened.flex },
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
vi.mock('../../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    brandColors: { success: 'green' },
    systemColors: {
      label: 'label',
      secondaryLabel: 'secondary',
      separator: 'separator',
      secondaryBackground: 'surface',
      tertiaryFill: 'fill',
    },
  }),
}));

import { FALLBACK_PREVIEW_BOARD, PlayerButtonsPreview } from '../PlayerButtonsPreview';
import { DEFAULT_PLAYER_BUTTONS } from '../../../lib/player-buttons';

afterEach(cleanup);

const TENSION = { ...FALLBACK_PREVIEW_BOARD, supportsMirroring: true };
const icons = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-icon]')].map((icon) => icon.getAttribute('data-icon'));

function preview(overrides: Partial<Parameters<typeof PlayerButtonsPreview>[0]> = {}) {
  return render(
    createElement(PlayerButtonsPreview, {
      buttons: DEFAULT_PLAYER_BUTTONS,
      previousNext: true,
      position: 'below',
      board: FALLBACK_PREVIEW_BOARD,
      ...overrides,
    }),
  );
}

describe('PlayerButtonsPreview', () => {
  it("draws today's Kilter bar under the board, and says it in one sentence", () => {
    const screen = preview();
    expect(icons(screen.container)).toEqual([
      'queue',
      'skip.previous',
      'tick.outline',
      'skip.next',
      'lightbulb',
      'favorite',
      'share',
    ]);
    expect(screen.getByText('40°')).toBeTruthy();
    expect(screen.getByTestId('player-buttons-preview').getAttribute('aria-label')).toBe(
      'mobile.settings.playerButtons.previewLabel ' +
        JSON.stringify({
          position: 'mobile.settings.playerButtons.position.below',
          buttons: [
            'mobile.settings.playerButtons.buttons.queue',
            'mobile.settings.playerButtons.fixed.previous',
            'mobile.settings.playerButtons.fixed.log',
            'mobile.settings.playerButtons.fixed.next',
            'mobile.settings.playerButtons.fixed.boardLight',
            'mobile.settings.playerButtons.buttons.favorite',
            'mobile.settings.playerButtons.buttons.angle',
            'mobile.settings.playerButtons.buttons.share',
          ].join(', '),
        }),
    );
  });

  it('draws the board it stands for: mirror leads on Tension, and no angle pill on a fixed board', () => {
    const screen = preview({ board: { ...TENSION, angleAvailable: false } });
    expect(icons(screen.container)).toEqual([
      'mirror',
      'skip.previous',
      'tick.outline',
      'skip.next',
      'lightbulb',
      'favorite',
      'share',
      'queue',
    ]);
    expect(screen.queryByText('40°')).toBeNull();
  });

  it('puts the bar above the board when asked, and the board gets what the bar leaves', () => {
    const screen = preview({ position: 'above' });
    const frame = screen.getByTestId('player-buttons-preview');
    const board = [...frame.children].find((child) => child.getAttribute('data-flex') === '1');
    expect(board).toBe(frame.lastElementChild);
  });

  it('draws no small row with every small button off, and empty ⏮ ⏭ slots with Previous and next off', () => {
    const allOff = {
      order: DEFAULT_PLAYER_BUTTONS.order,
      visible: { mirror: false, favorite: false, angle: false, share: false, queue: false },
    };
    const screen = preview({ buttons: allOff, previousNext: false });
    expect(icons(screen.container)).toEqual(['tick.outline', 'lightbulb']);
    expect(screen.queryByText('40°')).toBeNull();
  });
});
